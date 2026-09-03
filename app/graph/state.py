from typing import NotRequired, TypedDict


class AgentState(TypedDict):
    query: str
    context: str
    response: str
    voice_mode: NotRequired[bool]
    already_greeted: NotRequired[bool]
