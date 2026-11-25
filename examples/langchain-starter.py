# Agent402 + LangChain Starter
# pip install "agent402-structured-tools[langchain]" langchain langchain-openai
#
# Pure-CPU tools are FREE via built-in proof-of-work (no wallet, no keys).
# Live-data tools (market data, web search, EDGAR, on-chain) are wallet-only:
# construct the toolkit with x402_fetch=<callable> that signs USDC payment.
# See https://agent402.tools/docs.

from agent402_structured_tools import Agent402Toolkit
from langchain_openai import ChatOpenAI
from langchain.agents import create_tool_calling_agent, AgentExecutor
from langchain_core.prompts import ChatPromptTemplate

# Agent402's 500+ tools as four LangChain meta-tools (find / route / call / about)
toolkit = Agent402Toolkit(base_url="https://agent402.tools")
tools = toolkit.get_tools()

llm = ChatOpenAI(model="gpt-4o")  # bring your own key

prompt = ChatPromptTemplate.from_messages([
    ("system", "You are an assistant with access to Agent402's 500+ pay-per-call tools. "
               "Use agent402_find to pick a tool, then agent402_call to run it."),
    ("human", "{input}"),
    ("placeholder", "{agent_scratchpad}"),
])

agent = create_tool_calling_agent(llm, tools, prompt)
executor = AgentExecutor(agent=agent, tools=tools, verbose=True)

# Runs on the free tier (proof-of-work): a pure-CPU tool, no wallet needed.
result = executor.invoke({"input": "Generate a QR code for https://agent402.tools"})
print(result["output"])
