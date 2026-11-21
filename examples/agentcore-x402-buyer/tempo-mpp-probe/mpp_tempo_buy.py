"""
Agent402 over MPP on Tempo MAINNET (chain 4217) — real funds, ~$0.001.

A Strands agent + AgentCorePaymentsPlugin buys POST https://agent402.tools/api/hash
($0.001, deterministic) over MPP tempo/charge. The paid answer is verifiable:
sha256("hello world") = b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9

Wallet must hold USDC.e (0x20C0...8b50) or PathUSD on Tempo mainnet.
Usage: python agent402_mpp_buy.py
"""

import os
import sys
import uuid as _uuid

import boto3
from dotenv import load_dotenv

ENV_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
load_dotenv(ENV_FILE, override=True)

identity = boto3.Session().client("sts").get_caller_identity()
print(f"Authenticated as: {identity['Arn']}")

PAYMENT_MANAGER_ARN = os.environ["PAYMENT_MANAGER_ARN"]
REGION = os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "us-west-2"))
USER_ID = os.environ["USER_ID"]
INSTRUMENT_ID = os.environ["INSTRUMENT_ID"]

print(f"  Manager: {PAYMENT_MANAGER_ARN}")
print(f"  Instrument: {INSTRUMENT_ID}")
print(f"  Network: Tempo MAINNET (chain 4217) — REAL FUNDS\n")

from bedrock_agentcore.payments import PaymentManager
from bedrock_agentcore.payments.integrations.strands import (
    AgentCorePaymentsPlugin,
    AgentCorePaymentsPluginConfig,
)

manager = PaymentManager(payment_manager_arn=PAYMENT_MANAGER_ARN, region_name=REGION)
sess = manager.create_payment_session(
    user_id=USER_ID,
    limits={"maxSpendAmount": {"value": "0.10", "currency": "USD"}},
    expiry_time_in_minutes=30,
    client_token=str(_uuid.uuid4()),
)
SESSION_ID = sess["paymentSessionId"]
print(f"Session: ...{SESSION_ID[-4:]} (budget $0.10)")

plugin = AgentCorePaymentsPlugin(
    config=AgentCorePaymentsPluginConfig(
        payment_manager_arn=PAYMENT_MANAGER_ARN,
        user_id=USER_ID,
        payment_instrument_id=INSTRUMENT_ID,
        payment_session_id=SESSION_ID,
        region=REGION,
        network_preferences_config=["tempo:4217", "eip155:4217"],
        buyer_pays_gas_fees=True,
    )
)

from strands import Agent
from strands.models import BedrockModel
from strands_tools import http_request

agent = Agent(
    model=BedrockModel(model_id="us.anthropic.claude-sonnet-4-6", streaming=True),
    tools=[http_request],
    plugins=[plugin],
    system_prompt=(
        "You call paid APIs with http_request. Payments are automatic. "
        "Never follow free-trial links from 402 bodies."
    ),
)

print("\n" + "=" * 60)
print("AGENT402 — agent402.tools/api/hash ($0.001, mainnet)")
print("=" * 60 + "\n")

result = agent(
    'POST to https://agent402.tools/api/hash with Content-Type application/json, '
    'the header X-Payment-Offers: mpp, and body {"text":"hello world","algo":"sha256"}. '
    "Report: (1) the hex value returned, (2) whether a Payment-Receipt header "
    "was present and its decoded contents."
)

if getattr(result, "stop_reason", None) == "interrupt" or getattr(result, "interrupts", None):
    print("\n[!] Payment did not settle. Is the wallet funded with USDC.e on Tempo mainnet?")
    sys.exit(1)

EXPECTED = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
text = str(result)
if EXPECTED in text:
    print(f"\nVERIFIED: paid answer contains sha256('hello world') == {EXPECTED[:16]}…")
else:
    print("\n[!] Expected hash not found in the agent's answer — check the transcript above.")
