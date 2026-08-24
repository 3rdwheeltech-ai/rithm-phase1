# `rithm-api-bedrock-authoring` — the lyrics/title inline policy

`rithm-api-task-role` is console-managed and not in the repo, so this follows
the precedent set by commit `cd31991`: apply it as an **inline policy** and
check the JSON in here for the audit trail. Task-role permissions are evaluated
per call, so **no redeploy is needed**.

```bash
aws iam put-role-policy --role-name rithm-api-task-role \
  --policy-name rithm-api-bedrock-authoring \
  --policy-document file://ops/iam/rithm-api-task-role-bedrock.json
aws iam list-role-policies --role-name rithm-api-task-role
# expect: rithm-api-bedrock-authoring in the list
```

**The three regional foundation-model ARNs are the trap.** A cross-region
inference profile authorises against the profile ARN *and* the model ARN in
whichever region it routes the call to. Grant only the profile and it works —
until the day traffic routes to `us-west-2`, and then it is an intermittent
`AccessDeniedException` that nothing in the logs explains.

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
