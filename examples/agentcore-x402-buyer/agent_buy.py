#!/usr/bin/env python3
"""
Strands agent on AWS Bedrock AgentCore that buys an Agent402 tool over x402.

This is the SHOWCASE: a Strands agent with the AgentCore Payments plugin and an
HTTP tool. You prompt it to run a web search and then a cited answer, two paid
Agent402 tools; when each endpoint returns HTTP
402, the plugin signs the x402 micropayment (from the AgentCore-managed wallet),
retries, and the agent gets the paid result - no payment code in the agent.

Mirrors the AWS quickstart
(docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments-getting-started.html),
pointed at an Agent402 tool instead of a sample merchant.

Prereqs: same Payment Manager / Instrument / Session as direct_buy.py (created by
the `agents-pay` skill), plus Bedrock model access for the agent's LLM. Run
direct_buy.py first to confirm the wallet works, then:  python agent_buy.py
"""
import os

from strands import Agent
from strands_tools import http_request
from bedrock_agentcore.payments.integrations.config import AgentCorePaymentsPluginConfig
from bedrock_agentcore.payments.integrations.strands.plugin import AgentCorePaymentsPlugin

REGION = os.environ.get("AWS_REGION", "us-west-2")
PAYMENT_MANAGER_ARN = os.environ["PAYMENT_MANAGER_ARN"]
PAYMENT_INSTRUMENT_ID = os.environ["PAYMENT_INSTRUMENT_ID"]
PAYMENT_SESSION_ID = os.environ["PAYMENT_SESSION_ID"]
USER_ID = os.environ.get("PAYMENT_USER_ID", "agent402-demo-user")

BASE_URL = os.environ.get("AGENT402_BASE_URL", "https://agent402.tools")
# Set TARGET_URL to point the agent at one other paid endpoint instead (for
# example AWS's testnet sandbox merchant while you validate the wallet).
TARGET_URL = os.environ.get("TARGET_URL")

config = AgentCorePaymentsPluginConfig(
    payment_manager_arn=PAYMENT_MANAGER_ARN,
    user_id=USER_ID,
    payment_instrument_id=PAYMENT_INSTRUMENT_ID,
    payment_session_id=PAYMENT_SESSION_ID,
    region=REGION,
)
plugin = AgentCorePaymentsPlugin(config=config)

agent = Agent(
    system_prompt=(
        "You are an assistant that can call paid HTTP APIs. When a request "
        "returns HTTP 402 Payment Required, the payment plugin settles it "
        "automatically - just retry and use the result. Report the JSON you get back."
    ),
    tools=[http_request],
    plugins=[plugin],
)

if __name__ == "__main__":
    if TARGET_URL:
        prompt = f"GET {TARGET_URL} and report the JSON you get back."
    else:
        prompt = (
            f"First GET {BASE_URL}/api/search?q=x402+payment+protocol+adoption&count=5 "
            f"and list the result titles. Then GET "
            f"{BASE_URL}/api/answer?q=what+is+the+x402+payment+protocol%3F "
            f'and report the "answer" field with its citations.'
        )
    print(f"Prompt: {prompt}\n")
    response = agent(prompt)
    print(response)
