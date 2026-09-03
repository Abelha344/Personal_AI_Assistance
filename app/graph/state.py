from typing import TypedDict


class AgentState(TypedDict):
    query: str
    context: str
    response: str
    voice_mode: bool
