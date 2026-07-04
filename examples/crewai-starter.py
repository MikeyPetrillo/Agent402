# Agent402 + CrewAI Starter
# pip install agent402-langchain crewai crewai-tools

from crewai import Agent, Task, Crew
from agent402_langchain import Agent402Toolkit

toolkit = Agent402Toolkit(base_url="https://agent402.tools")
tools = toolkit.get_tools()

researcher = Agent(
    role="Financial Researcher",
    goal="Research companies using live market data",
    backstory="You have access to Agent402's 1,355 tools for real-time data.",
    tools=tools,
    verbose=True,
)

task = Task(
    description="Research NVDA: get the current stock price, key financials, and recent news.",
    expected_output="A brief research summary with price, financials, and news links.",
    agent=researcher,
)

crew = Crew(agents=[researcher], tasks=[task], verbose=True)
result = crew.kickoff()
print(result)
