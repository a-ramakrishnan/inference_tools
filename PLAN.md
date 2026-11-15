# One-Week Inference Portfolio Plan

Nov 15, 2026

## Goal and deliverables

By Sunday 22 November, publish one public repo and one two-page write-up that show hands-on work on AI inference. The work supports the technical requirements of the Arm India engineering leadership role; the organization-building requirements rest on track record, not on this project.

| Deliverable | What it shows | Requirement it supports |
| --- | --- | --- |
| Benchmark study across Arm and x86 | How quantization, threads, context length and concurrency change latency, throughput and memory | Understanding of AI inference and the relationship between workload, hardware and system performance |
| Inference gateway with tracing and usage accounting | A working service in front of two model servers | Distributed tracing and usage accounting (nice-to-have) |
| Agent-traffic experiment | How multi-turn tool-calling traffic differs from chat traffic | Technical depth to assess architecture for new workloads |
| Build log | Where AI sped up the work and where its output had to be corrected | Practical experience improving software development with AI |

## Assumptions and setup

The plan assumes a laptop, a few hours a day, and an AI coding assistant writing most of the code. None of these has been confirmed yet.

- **Hardware:** a laptop for local runs (an Apple Silicon Mac counts as the Arm machine), plus one rented x86 and one AWS Graviton instance on Wednesday.
- **Model server:** llama.cpp, serving one small open model in two quantization levels.
- **Deployment:** Docker Compose on one machine.
- **Tracing:** OpenTelemetry with a local trace viewer.
- **Out of scope:** Kubernetes. It is a nice-to-have in the role and is not claimed anywhere in the repo or write-up.
- **Out of scope:** the OpenWorker-style agent build. Saturday uses a 50-line tool-calling loop instead.

Open questions:

- [ ] Which laptop will the local runs use, and how much memory does it have?
- [ ] Is there an AWS account available for the Wednesday cloud runs?

## Schedule

Monday to Wednesday is the benchmark study, Thursday and Friday the gateway, Saturday the agent experiment, and Sunday the write-up.

| Day | Goal | Output |
| --- | --- | --- |
| Mon 16 Nov | Serve one small open model with llama.cpp locally. Write a load script that records time to first token, tokens per second and memory. | One working measurement saved to CSV |
| Tue 17 Nov | Run the full sweep on the laptop. | Complete results table |
| Wed 18 Nov | Repeat the key runs on a rented x86 instance and a Graviton instance. Chart everything. | 4–5 charts, each with a paragraph on why the curve looks that way |
| Thu 19 Nov | Build the gateway: one OpenAI-compatible endpoint routing between two llama.cpp servers, with a request queue. | Gateway running under Docker Compose |
| Fri 20 Nov | Add OpenTelemetry tracing per request and a usage table of tokens per API key. | A trace view and a usage report |
| Sat 21 Nov | Send agent-style traffic through the gateway: a multi-turn tool-calling loop with a growing context, with and without prompt caching. | One chart comparing agent and chat traffic |
| Sun 22 Nov | Write the README and the two-page write-up. Publish the repo. | Public repo and write-up |

## Benchmark sweep

The laptop sweep is 36 configurations (2 × 3 × 2 × 3), each run three times with output fixed at 200 tokens. These values are a proposed starting point; adjust them once Monday's first measurement shows how long a run takes.

| Variable | Values |
| --- | --- |
| Quantization | 4-bit, 8-bit |
| Threads | Half the performance cores, all performance cores, all cores |
| Prompt length | About 200 tokens, about 4,000 tokens |
| Concurrent requests | 1, 4, 8 |

Metrics recorded per run:

- Time to first token (ms)
- Tokens per second per request
- Total tokens per second across all concurrent requests
- Peak memory (GB)
- Cost per million output tokens (cloud instances only)

On Wednesday, repeat only the 4-bit runs at all performance cores on the two cloud instances. That is 6 configurations per machine, enough for the Arm versus x86 comparison.

## Gateway scope

The gateway is a single service that accepts OpenAI-style chat requests and forwards each one to one of two llama.cpp servers: a small fast model and a larger one.

| In scope | Out of scope |
| --- | --- |
| One chat-completions endpoint with streaming | Kubernetes, autoscaling, multi-node deployment |
| Routing by a simple rule (requested model name, or prompt length) | Learned or cost-optimized routing |
| A bounded request queue with a concurrency limit per backend | Batching inside the model server |
| One trace per request: queue wait, time to first token, generation time | Dashboards and alerting |
| A usage table: API key, model, input tokens, output tokens, timestamp | Billing, quotas, rate limits |
| API keys read from a config file | User management and authentication flows |

## If the week slips

Cut Saturday first, then Friday. Monday to Wednesday is protected because the benchmark study is the piece that matches the role's required skills.

1. Drop the agent experiment and mention it as planned follow-up work.
2. Drop tracing and keep only the usage table.
3. Drop the gateway and publish the benchmark study alone.

Working rules:

- Let AI write the scripts and plumbing. Write the explanations of the results yourself.
- Be able to defend every chart under questioning. Remove any chart you cannot explain.
- Add to the build log at the end of each day: what AI got right, what it got wrong, what you changed.
- Claim nothing in the write-up that the repo does not show.

## Write-up outline

The write-up is two pages and reads as a set of decisions, because that is how a leadership candidate's technical work is judged.

1. **What I measured.** The setup, the sweep and the three machines, in one paragraph and one table.
2. **What the numbers show.** The 4–5 charts, each with the reason behind its shape.
3. **What surprised me.** Two or three results that went against expectation, and what explained them.
4. **How agent traffic differs.** The Saturday comparison and what it implies for serving.
5. **What I would invest in.** Three priorities for an inference platform team, each tied to a result above.
6. **How I built it.** A short account from the build log of using AI in development, including where it was wrong.

Section 5 is the one that connects the project to the role, so draft it first on Sunday.
