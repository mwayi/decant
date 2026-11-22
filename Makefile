PYTHON ?= python3

.PHONY: up down status logs

up:
	$(PYTHON) scripts/local-dev.py up

down:
	$(PYTHON) scripts/local-dev.py down

status:
	$(PYTHON) scripts/local-dev.py status

logs:
	$(PYTHON) scripts/local-dev.py logs
