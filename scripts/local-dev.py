#!/usr/bin/env python3
"""Start the existing private Docker installation through a local kind ingress."""

import argparse
import hashlib
import ipaddress
import json
import os
import shutil
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
IMAGE = "decant-local:localhost"
URL = "http://decant.localhost"
NAMESPACE = "decant-local"


def run(args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def output(args):
    return run(args, stdout=subprocess.PIPE).stdout.strip()


def local_context():
    context = output(["kubectl", "config", "current-context"])
    server = output([
        "kubectl", "--context", context, "config", "view", "--minify",
        "-o", "jsonpath={.clusters[0].cluster.server}",
    ])
    host = urllib.parse.urlparse(server).hostname
    if not context.startswith("kind-") or host not in ("localhost", "127.0.0.1", "::1", "0.0.0.0"):
        raise RuntimeError("Select a local kind context before using this target.")
    return ["kubectl", "--context", context]


def ingress_resources(gateways):
    allowed = ["127.0.0.1/32", "::1/128"]
    for gateway in gateways:
        address = ipaddress.ip_address(gateway)
        allowed.append(f"{address}/{address.max_prefixlen}")
    metadata = {"name": "decant", "namespace": NAMESPACE}
    return {"apiVersion": "v1", "kind": "List", "items": [
        {"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": NAMESPACE}},
        {"apiVersion": "v1", "kind": "Service", "metadata": metadata,
         "spec": {"type": "ExternalName", "externalName": "host.docker.internal",
                  "ports": [{"name": "http", "port": 3000, "targetPort": 3000}]}},
        {"apiVersion": "networking.k8s.io/v1", "kind": "Ingress",
         "metadata": {**metadata, "annotations": {
             "nginx.ingress.kubernetes.io/ssl-redirect": "false",
             "nginx.ingress.kubernetes.io/proxy-buffering": "off",
             "nginx.ingress.kubernetes.io/proxy-read-timeout": "3600",
             "nginx.ingress.kubernetes.io/whitelist-source-range": ",".join(allowed),
         }},
         "spec": {"ingressClassName": "nginx", "rules": [{
             "host": "decant.localhost", "http": {"paths": [{
                 "path": "/", "pathType": "Prefix", "backend": {
                     "service": {"name": "decant", "port": {"name": "http"}},
                 },
             }]},
         }]}},
    ]}


def up(config, compose):
    kubectl = local_context()
    refresh = config.parent / "refresh-mounts.py"
    if refresh.exists():
        run([sys.executable, str(refresh)])
    data = json.loads(config.read_text())
    mounts = data["services"]["decant"].get("volumes", [])
    mounts[:] = [mount for mount in mounts if not (
        mount.get("type") == "bind" and
        ("/.git/" in mount["target"] or mount["target"].endswith("/.git")) and
        not Path(mount["source"]).exists()
    )]
    metadata = config.parent / "git-metadata"
    metadata.mkdir(mode=0o700, exist_ok=True)
    for mount in mounts:
        if mount.get("type") == "bind" and ("/.git/" in mount["target"] or mount["target"].endswith("/.git")):
            source = Path(mount["source"])
            snapshot = metadata / hashlib.sha256(mount["target"].encode()).hexdigest()
            if source.resolve() != snapshot.resolve():
                shutil.copyfile(source, snapshot)
            snapshot.chmod(0o644)
            mount["source"] = str(snapshot)
    for network in data.get("networks", {}).values():
        if network.get("external"):
            name = network["name"]
            found = subprocess.run(["docker", "network", "inspect", name],
                                   text=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if found.returncode:
                run(["docker", "network", "create", name])
            details = json.loads(output(["docker", "network", "inspect", name]))[0]
            gateways = [item["Gateway"] for item in details["IPAM"]["Config"] if item.get("Gateway")]
            data["services"]["decant"]["environment"]["DECANT_TRUSTED_PEERS"] = ",".join(gateways)
    run(["docker", "build", "--build-arg", "DECANT_VERSION=0.18.0-work-types-local",
         "-t", IMAGE, str(ROOT)])
    data["services"]["decant"]["image"] = IMAGE
    temporary = config.with_suffix(".tmp")
    temporary.write_text(json.dumps(data, indent=2) + "\n")
    temporary.chmod(0o600)
    temporary.replace(config)
    run(compose + ["up", "-d"])
    kind = json.loads(output(["docker", "network", "inspect", "kind"]))[0]
    gateways = [item["Gateway"] for item in kind["IPAM"]["Config"] if item.get("Gateway")]
    run(kubectl + ["apply", "-f", "-"], input=json.dumps(ingress_resources(gateways)))
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + 60
    failure = "not ready"
    while time.monotonic() < deadline:
        try:
            request = urllib.request.Request("http://127.0.0.1/api/health", headers={"Host": "decant.localhost"})
            with opener.open(request, timeout=5) as response:
                if response.status == 200 and json.load(response).get("ok") is True:
                    print(f"\nDecant is ready at {URL}", flush=True)
                    return
        except (OSError, ValueError) as error:
            failure = str(error)
        time.sleep(1)
    raise RuntimeError(f"The local route did not become ready: {failure}")


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["up", "down", "status", "logs"])
    parser.add_argument("--compose", type=Path,
                        default=Path.home() / ".config/decant-docker/compose.json")
    args = parser.parse_args()
    config = args.compose.resolve()
    if not config.is_file():
        raise RuntimeError(f"Local Docker configuration not found: {config}. See docs/distribution.md.")
    compose = ["docker", "compose", "-f", str(config)]
    if args.action == "up":
        up(config, compose)
    elif args.action == "down":
        run(local_context() + ["delete", "ingress/decant", "service/decant", "-n", NAMESPACE,
                               "--ignore-not-found"])
        run(compose + ["stop"])
    else:
        run(compose + (["ps"] if args.action == "status" else ["logs", "--tail", "50"]))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError) as error:
        print(f"decant: {error}", file=sys.stderr)
        sys.exit(1)
