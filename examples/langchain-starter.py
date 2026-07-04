# Agent402 + LangChain Starter
# pip install agent402-langchain langchain-openai

from agent402_langchain import Agent402Toolkit
from langchain_openai import ChatOpenAI
from langchain.agents import create_tool_calling_agent, AgentExecutor
from langchain_core.prompts import ChatPromptTemplate

# Agent402 tools — free via proof-of-work, no wallet needed
toolkit = Agent402Toolkit(base_url="https://agent402.tools")
tools = toolkit.get_tools()

# Your LLM (bring your own key)
llm = ChatOpenAI(model="gpt-4o")

prompt = ChatPromptTemplate.from_messages([
    ("system", "You are a helpful assistant with access to Agent402's 1,355 web tools."),
    ("human", "{input}"),
    ("placeholder", "{agent_scratchpad}"),
])

agent = create_tool_calling_agent(llm, tools, prompt)
executor = AgentExecutor(agent=agent, tools=tools, verbose=True)

# Try it
result = executor.invoke({"input": "What's the current price of AAPL stock?"})
print(result["output"])
