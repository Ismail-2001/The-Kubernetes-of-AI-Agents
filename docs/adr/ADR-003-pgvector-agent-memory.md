# ADR-003: pgvector for Agent Memory

## Status
Accepted

## Date
2026-09-17

## Context
Agents in E-GAOP need semantic search capabilities over conversation history, knowledge bases, and tool outputs. This requires storing and querying high-dimensional vector embeddings alongside traditional relational data. Using a separate vector database introduces additional infrastructure complexity and data synchronization challenges.

## Decision
Use the pgvector PostgreSQL extension for vector similarity search within the existing PostgreSQL database. Agent memories, conversation embeddings, and knowledge base entries will be stored as vector columns in PostgreSQL tables, enabling both relational queries and vector similarity search from a single database.

## Consequences

### Positive
- Single database for relational data and vector search (no separate vector DB to maintain)
- Leverages existing PostgreSQL operational knowledge and tooling
- Supports hybrid queries: combine relational filtering with vector similarity search
- ACID transactions guarantee consistency between relational and vector data
- Familiar SQL interface for querying embeddings

### Negative
- pgvector has scaling limits compared to purpose-built vector databases (Milvus, Pinecone)
- Index build times can be slow for very large vector collections
- Limited support for advanced vector operations (ANN algorithms) compared to specialized solutions
- PostgreSQL connection pool must be shared between relational and vector workloads

### Risks
- Scaling limits mitigated by using IVFFlat/HNSW indexes with appropriate parameters and monitoring query performance
- Performance degradation at scale mitigated by partitioning vector tables and using read replicas for search-heavy workloads
- If scaling limits are hit, pgvector's copy format allows migration to a dedicated vector database
