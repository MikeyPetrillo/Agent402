#!/usr/bin/env python3
"""
Deterministic x402 buy of an Agent402 tool from AWS Bedrock AgentCore Payments.

This is the RELIABLE proof of the loop (no LLM in the path): it fetches a paid
Agent402 endpoint, gets the HTTP 402, asks AgentCore Payments to sign the x402
payment, retries, and verifies the 200 payload. Use this to confirm your wallet
+ Payment Manager are wired before running the agent showcase (agent_buy.py).

Prereqs (created once by the `agents-pay` / `agents-build` skill in the
aws-agents plugin - see README):
  - A Payment Manager + Connector (Coinbase CDP or Stripe Privy)
  - A funded, ACTIVE Payment Instrument (crypto wallet)
  - A Payment Session (time-bounded, with a spend limit)
Set their ids in the environment (see .env.example), then:  python direct_buy.py

Testnet first: point TARGET_URL at AWS's sandbox merchant
(https://sandbox.node4all.com/v1/x402-test) with a Base-Sepolia-funded wallet to
validate for free. To buy a REAL Agent402 tool, the wallet must hold USDC on
Base MAINNET (Agent402 production settles on Base) - see README.
"""
import os
import sys
import json
import uuid
import urllib.request
import urllib.error

import boto3
from bedrock_agentcore.payments import PaymentManager

REGION = os.environ.get("AWS_REGION", "us-west-2")
PROFILE = os.environ.get("AWS_PROFILE", "agent402")
PAYMENT_MANAGER_ARN = os.environ["PAYMENT_MANAGER_ARN"]
PAYMENT_INSTRUMENT_ID = os.environ["PAYMENT_INSTRUMENT_ID"]
PAYMENT_SESSION_ID = os.environ["PAYMENT_SESSION_ID"]
USER_ID = os.environ.get("PAYMENT_USER_ID", "agent402-demo-user")

# The Agent402 tool to buy. Default: POST /api/hash (deterministic, $0.001).
TARGET_URL = os.environ.get("TARGET_URL", "https://agent402.tools/api/hash")
TARGET_METHOD = os.environ.get("TARGET_METHOD", "POST")
TARGET_BODY = os.environ.get("TARGET_BODY", json.dumps({"text": "hello world", "algo": "sha256"}))
# sha256("hello world") - the sample verifies the paid response matches this.
EXPECTED_HASH = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"

boto3.setup_default_session(profile_name=PROFILE, region_name=REGION)
manager = PaymentManager(payment_manager_arn=PAYMENT_MANAGER_ARN, region_name=REGION)


def _request(url, method, body, extra_headers=None):
    headers = {"Accept": "application/json"}
    data = None
    if method == "POST":
        headers["Content-Type"] = "application/json"
        data = body.encode("utf-8")
    headers.update(extra_headers or {})
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, dict(resp.headers), resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        # A 402 is expected on the first (unpaid) call - return it, don't raise.
        return e.code, dict(e.headers), e.read().decode("utf-8")


def main():
    print(f"1) Unpaid {TARGET_METHOD} {TARGET_URL}")
    status, headers, body = _request(TARGET_URL, TARGET_METHOD, TARGET_BODY)
    if status != 402:
        print(f"   expected HTTP 402, got {status}: {body[:200]}")
        # A free/PoW-eligible tool served without payment, or an error.
        sys.exit(1)
    print("   -> HTTP 402 Payment Required (as expected)")

    print("2) AgentCore Payments signs the x402 payment")
    # The 402 also carries MPP challenges (WWW-Authenticate: Payment), and the
    # payment service pays an MPP challenge whenever it is handed one. This
    # sample pays over x402, so it hands over the x402 offer alone.
    x402_headers = {k: v for k, v in headers.items() if k.lower() != "www-authenticate"}
    payment_required_request = {"statusCode": 402, "headers": x402_headers, "body": body}
    proof = manager.generate_payment_header(
        user_id=USER_ID,
        payment_instrument_id=PAYMENT_INSTRUMENT_ID,
        payment_session_id=PAYMENT_SESSION_ID,
        payment_required_request=payment_required_request,
        client_token=str(uuid.uuid4()),
    )
    # `proof` carries the x402 payment header(s) to replay on the retry.
    pay_headers = proof if isinstance(proof, dict) else {"X-PAYMENT": str(proof)}
    print(f"   -> signed ({', '.join(pay_headers)})")

    print("3) Retry with the payment proof")
    status, headers, body = _request(TARGET_URL, TARGET_METHOD, TARGET_BODY, pay_headers)
    print(f"   -> HTTP {status}")
    if status != 200:
        print(f"   payment did not settle: {body[:300]}")
        sys.exit(1)

    payload = json.loads(body)
    print("4) Paid response:")
    print(json.dumps(payload, indent=2)[:600])

    # The hash tool answers {algo, hex, base64}; the sample checks the hex digest.
    if TARGET_URL.endswith("/api/hash"):
        got = payload.get("hex")
        if got != EXPECTED_HASH:
            print(f"\nNOT VERIFIED: expected hex {EXPECTED_HASH}, got {got!r}")
            sys.exit(1)
        print(f"\nVERIFIED: sha256('hello world') == {EXPECTED_HASH}")
    lower = {k.lower(): v for k, v in headers.items()}
    receipt = lower.get("payment-response") or lower.get("x-payment-response")
    if receipt:
        print("Settlement receipt present (Payment-Response header).")
    print("\nDone: an AgentCore-hosted wallet bought an Agent402 tool over x402.")


if __name__ == "__main__":
    main()
