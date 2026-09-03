from langgraph.graph import END, START, StateGraph

from app.graph.state import AgentState
from app.llm.gemini import generate_response
from app.retrieval.vector_store import vector_store


def retrieve_context(state: AgentState) -> AgentState:
    try:
        docs = vector_store.search(state["query"])
    except Exception:
        # Allow chat to continue if retrieval/embeddings fail
        return {**state, "context": ""}

    if not docs:
        return {**state, "context": ""}

    context = "\n\n".join(
        f"[{i + 1}] {doc.content}" for i, doc in enumerate(docs)
    )
    return {**state, "context": context}


def generate(state: AgentState) -> AgentState:
    response = generate_response(state["query"], state["context"])
    return {**state, "response": response}


def build_graph():
    graph = StateGraph(AgentState)
    graph.add_node("retrieve", retrieve_context)
    graph.add_node("generate", generate)
    graph.add_edge(START, "retrieve")
    graph.add_edge("retrieve", "generate")
    graph.add_edge("generate", END)
    return graph.compile()


agent = build_graph()
