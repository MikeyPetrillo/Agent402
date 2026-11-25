"""agent402-langchain is renamed to agent402-structured-tools. This release forwards to it."""
import warnings

warnings.warn(
    "agent402-langchain is renamed to agent402-structured-tools (same API): pip install agent402-structured-tools, then import agent402_structured_tools. This name gets no further releases.",
    DeprecationWarning,
    stacklevel=2,
)

from agent402_structured_tools import *  # noqa: F401,F403,E402
from agent402_structured_tools import __all__  # noqa: E402
