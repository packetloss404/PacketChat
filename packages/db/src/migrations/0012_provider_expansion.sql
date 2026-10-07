alter table provider_accounts drop constraint if exists provider_accounts_provider_check;
alter table provider_accounts add constraint provider_accounts_provider_check
  check (provider in ('openai-compatible', 'openai', 'azure-openai', 'anthropic', 'google', 'xai', 'sugar', 'opencode-go', 'ollama-cloud', 'cline-pass', 'perplexity', 'minimax'));

alter table model_catalog drop constraint if exists model_catalog_provider_check;
alter table model_catalog add constraint model_catalog_provider_check
  check (provider in ('openai-compatible', 'openai', 'azure-openai', 'anthropic', 'google', 'xai', 'sugar', 'opencode-go', 'ollama-cloud', 'cline-pass', 'perplexity', 'minimax'));
