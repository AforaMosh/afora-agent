# Afora Amazon Bedrock Provider

Official Afora provider plugin for Amazon Bedrock. It adds Bedrock model discovery, text generation, embeddings, and guardrail-aware provider routing for agents that use AWS-hosted models.

Install from Afora:

```bash
afora plugins install @afora/amazon-bedrock-provider
```

Configure AWS credentials and region through your normal Afora credential/profile setup, then select Bedrock models with the `amazon-bedrock/...` provider prefix.
