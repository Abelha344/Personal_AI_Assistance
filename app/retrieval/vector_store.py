from dataclasses import dataclass
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse
import socket

from pgvector.psycopg import register_vector
from psycopg.rows import dict_row
from psycopg.types.json import Json
from psycopg_pool import ConnectionPool

from app.config import settings
from app.retrieval.embeddings import embed_text


@dataclass
class RetrievedDocument:
    content: str
    metadata: dict
    score: float


def _ipv4_conninfo(database_url: str) -> str:
    """Prefer IPv4 so Neon connections don't fail on unreachable IPv6."""
    parsed = urlparse(database_url)
    host = parsed.hostname
    if not host:
        return database_url

    try:
        infos = socket.getaddrinfo(host, parsed.port or 5432, socket.AF_INET, socket.SOCK_STREAM)
        ipv4 = infos[0][4][0]
    except OSError:
        return database_url

    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    query["hostaddr"] = ipv4
    return urlunparse(parsed._replace(query=urlencode(query)))


class VectorStore:
    def __init__(self) -> None:
        self._pool: ConnectionPool | None = None

    def _get_pool(self) -> ConnectionPool:
        if self._pool is None:
            self._pool = ConnectionPool(
                conninfo=_ipv4_conninfo(settings.database_url),
                min_size=0,
                max_size=5,
                timeout=5,
                kwargs={
                    "row_factory": dict_row,
                    "connect_timeout": 5,
                },
                open=False,
            )
            self._pool.open()
        return self._pool

    def _setup_connection(self, conn) -> None:
        register_vector(conn)

    def search(self, query: str, top_k: int | None = None) -> list[RetrievedDocument]:
        k = top_k or settings.top_k
        query_embedding = embed_text(query)

        with self._get_pool().connection() as conn:
            self._setup_connection(conn)
            conn.execute("SET LOCAL ivfflat.probes = 100")
            rows = conn.execute(
                """
                SELECT content, metadata, 1 - (embedding <=> %s::vector) AS score
                FROM documents
                ORDER BY embedding <=> %s::vector
                LIMIT %s
                """,
                (query_embedding, query_embedding, k),
            ).fetchall()

        return [
            RetrievedDocument(
                content=row["content"],
                metadata=row["metadata"] or {},
                score=float(row["score"]),
            )
            for row in rows
        ]

    def add_document(self, content: str, metadata: dict | None = None) -> None:
        embedding = embed_text(content)
        with self._get_pool().connection() as conn:
            self._setup_connection(conn)
            conn.execute(
                """
                INSERT INTO documents (content, metadata, embedding)
                VALUES (%s, %s, %s)
                """,
                (content, Json(metadata or {}), embedding),
            )

    def close(self) -> None:
        if self._pool is not None:
            self._pool.close()
            self._pool = None


vector_store = VectorStore()
