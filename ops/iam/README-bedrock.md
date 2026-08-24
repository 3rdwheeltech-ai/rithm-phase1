# `rithm-api-bedrock-authoring` — the lyrics/title inline policy

`rithm-api-task-role` is console-managed and not in the repo, so this follows
the precedent set by commit `cd31991`: apply it as an **inline policy** and
check the JSON in here for the audit trail. Task-role permissions are evaluated
per call, so **no redeploy is needed**.

**Applied 2026-08-24 as `rithm-api-task-bedrock`** — that name, not the
`rithm-api-bedrock-authoring` this file originally specified. Nothing depends
on the name; it is recorded here so a later diff of live-vs-repo looks for the
right one.

```bash
aws iam put-role-policy --role-name rithm-api-task-role \
  --policy-name rithm-api-task-bedrock \
  --policy-document file://ops/iam/rithm-api-task-role-bedrock.json
aws iam list-role-policies --role-name rithm-api-task-role
# expect: rithm-api-task-bedrock in the list
```

Verified against the live profiles rather than assumed — both cross-region
profiles route to exactly the three regions the policy grants:

```bash
aws bedrock get-inference-profile --region us-east-1 \
  --inference-profile-identifier us.amazon.nova-2-lite-v1:0 \
  --query 'models[].modelArn'
# us-east-1, us-east-2, us-west-2 -- all three are in the policy above
```

**The three regional foundation-model ARNs are the trap.** A cross-region
inference profile authorises against the profile ARN *and* the model ARN in
whichever region it routes the call to. Grant only the profile and it works —
until the day traffic routes to `us-west-2`, and then it is an intermittent
`AccessDeniedException` that nothing in the logs explains.

## A3 — the task definition still needs the env vars

As of 2026-08-24 the live `rithm-api` task definition (rev 13) carries only the
DEAD `BEDROCK_HAIKU_MODEL_ID` from Day 1 — a setting nothing reads any more,
safe to drop — and none of `BEDROCK_ENABLED`, `BEDROCK_LYRICS_MODEL_ID` or
`BEDROCK_TITLE_MODEL_ID`. **`BEDROCK_ENABLED` defaults to False, so until they
are added the feature is entirely off in production** and every track gets a
prompt-derived title with `lyrics_source=acestep`.

Do this LAST, after the API image carrying the feature is deployed. Setting it
on an image without the code does nothing, and doing it first means the switch
is on before the thing it switches exists.

## Two gates, not one

IAM is only half of it. Anthropic models on Bedrock are ALSO gated behind a
one-time, per-ACCOUNT **"use case details" form** (Bedrock → Model access →
Anthropic → Submit use case details). Until it is submitted, every Anthropic id
returns:

```
ResourceNotFoundException: Model use case details have not been submitted for
this account. Fill out the Anthropic use case details form before using the
model.
```

Verified 2026-08-24: this is account-wide, not per-model — Haiku 4.5,
Claude 3.5 Haiku and Claude 3 Haiku all fail identically, so **no model-id
substitution routes around it**. Amazon and Google models are unaffected.

Because that error is a `ClientError`, `converse` swallows it and the request
degrades to a prompt-derived title and ACE-Step's own lyrics — a 202 either
way. The feature simply never works, and nothing in the logs says why beyond
one `bedrock_converse_failed` line. That is the first thing to check.

**Until the form clears** the live taskdef sets
`BEDROCK_LYRICS_MODEL_ID=us.amazon.nova-2-lite-v1:0`. Measured over 5 calls
against the real lyricist prompt:

| Model | median | max | verdict |
|---|---|---|---|
| `us.amazon.nova-2-lite-v1:0` | 2.3s | 2.7s | in use |
| `amazon.nova-pro-v1:0` | 2.2s | 3.5s | viable alternative |
| `google.gemma-3-27b-it` | — | >10s | **rejected** — exceeds the client read timeout |
| `google.gemma-3-12b-it` | — | >10s | **rejected** — same |

Gemma is worth a note because it looks attractive on a single sample (one 4.5s
call with the best imagery of the lot) and is not viable on five: it sits in
front of a 202 the user is watching a spinner for, and the 8s lyrics budget is
a latency ceiling, not a suggestion.

Model access must also be enabled in the console (Bedrock → Model access,
`us-east-1`) for **Anthropic · Claude Haiku 4.5** and **Amazon · Nova Micro**.
Verify both ids before they go near a task definition — a wrong id fails
silently into the fallback, exactly like no access at all:

```bash
aws bedrock list-inference-profiles --region us-east-1 \
  --query "inferenceProfileSummaries[?contains(inferenceProfileId,'haiku-4-5')].inferenceProfileId"
# expect: [ "us.anthropic.claude-haiku-4-5-20251001-v1:0" ]

aws bedrock list-foundation-models --region us-east-1 \
  --query "modelSummaries[?modelId=='amazon.nova-micro-v1:0'].modelId"
# expect: [ "amazon.nova-micro-v1:0" ]
```

If the first comes back empty, fall back to
`anthropic.claude-3-5-haiku-20241022-v1:0` — a plain on-demand id, no `us.`
prefix, and **no inference-profile ARN in the policy above**. Record the
substitution here if you take it.

> The local IAM user `rithm-dev-local` has **no** `bedrock:*` at all — even
> `ListFoundationModels` is denied. Run both commands from an admin profile, or
> add a read-only Bedrock statement to that user.
