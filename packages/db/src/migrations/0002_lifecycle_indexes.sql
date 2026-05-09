create index if not exists attachments_owner_user_id_idx on attachments(owner_user_id);
create index if not exists attachments_conversation_id_idx on attachments(conversation_id);
create index if not exists attachments_owner_bucket_object_idx on attachments(owner_user_id, bucket, object_key);

create index if not exists knowledge_bases_owner_user_id_idx on knowledge_bases(owner_user_id);
create index if not exists knowledge_documents_knowledge_base_id_idx on knowledge_documents(knowledge_base_id);
create index if not exists knowledge_documents_owner_user_id_idx on knowledge_documents(owner_user_id);
create index if not exists knowledge_documents_attachment_id_idx on knowledge_documents(attachment_id);
create index if not exists knowledge_documents_ingest_status_idx on knowledge_documents(ingest_status);
create index if not exists knowledge_chunks_owner_user_id_idx on knowledge_chunks(owner_user_id);

create index if not exists conversation_runs_owner_user_status_idx on conversation_runs(owner_user_id, status);
create index if not exists agent_runs_owner_user_status_idx on agent_runs(owner_user_id, status);

create index if not exists job_failures_created_at_idx on job_failures(created_at desc);
create index if not exists job_failures_queue_created_at_idx on job_failures(queue_name, created_at desc);
