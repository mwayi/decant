import { expect, test } from "bun:test";
import { validateLocalRequest } from "../src/server/security.ts";

const context = {
  boundHostname: "0.0.0.0",
  remoteAddress: "172.21.0.1",
  trustedPeers: ["172.21.0.1"],
};
function validate(url: string, init?: RequestInit, peer = context.remoteAddress) {
  const request = new Request(url, init);
  return validateLocalRequest(request, new URL(url), { ...context, remoteAddress: peer });
}

test("localhost subdomains work behind a trusted local proxy", () => {
  expect(validate("http://decant.localhost/api/config")).toBeNull();
  expect(
    validate("http://decant.localhost/api/sync", {
      method: "POST",
      headers: { origin: "http://decant.localhost", "sec-fetch-site": "same-origin" },
    }),
  ).toBeNull();
});

test("localhost subdomains keep host, peer, and same-origin restrictions", () => {
  for (const host of [
    "decant.localhost.evil.example",
    "evil-localhost.example",
    "localhost.example",
  ]) {
    expect(validate(`http://${host}/api/config`)?.status).toBe(403);
  }
  expect(validate("http://decant.localhost/api/config", undefined, "172.21.0.99")?.status).toBe(
    403,
  );
  for (const origin of [
    "http://other.localhost",
    "http://decant.localhost:3000",
    "https://evil.example",
  ]) {
    expect(
      validate("http://decant.localhost/api/sync", { method: "POST", headers: { origin } })?.status,
    ).toBe(403);
  }
});
