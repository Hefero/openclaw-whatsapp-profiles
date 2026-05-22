## Summary

- 

## Checks

- [ ] `npm run typecheck`
- [ ] `npm run openclaw:schema-check`
- [ ] Public-file scan for secrets/phones/JIDs/emails
- [ ] `.env`, `data/`, and `config/bot-policy.local.json` are not staged

## Runtime Notes

- [ ] OpenClaw flow still starts with `npm run warmup`
- [ ] Twilio changes do not expose `/openclaw/message`
- [ ] Wildcard intake keeps unconfigured chats in `observe`

## Docs

- [ ] README updated when setup/runtime behavior changes
- [ ] Security notes updated when network exposure changes
