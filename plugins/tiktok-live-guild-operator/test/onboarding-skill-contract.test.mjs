import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skillPath = new URL("../skills/operate-guild-onboarding/SKILL.md", import.meta.url);

test("onboarding skill composes Outlook with agent-operated TikTok steps", async () => {
  const skill = await readFile(skillPath, "utf8");
  assert.match(skill, /microsoft_outlook_email_search_messages/u);
  assert.match(skill, /prepare_access_workflow/u);
  assert.match(skill, /agent operation policy|agent.*execute/iu);
  assert.match(skill, /直接在.*Backstage|directly.*Backstage/iu);
  assert.match(skill, /OTP|验证码/u);
  assert.match(skill, /never|不得|不要/iu);
  assert.match(skill, /write_verified/u);
  assert.match(skill, /Creator removal remains the only explicit approval-gated/u);
  assert.match(skill, /list_permissions/u);
});
