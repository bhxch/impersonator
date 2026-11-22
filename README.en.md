English | [简体中文](README.md)

# Impersonator Proxy

An AI model proxy gateway with multiple backends, multiple endpoints, model mapping, and Anthropic↔OpenAI protocol conversion.

## Highlights

Unlike switcher tools such as cc-switch or magpie — where only one endpoint configuration is active globally at any given moment — this project runs as a persistent service that **exposes multiple groups of mapped endpoints simultaneously**:

- Multiple preset endpoints coexist: set a different env (e.g. point `ANTHROPIC_BASE_URL` at a different entry) before launching an agent, and that session uses a different preset
- Different sessions on the same machine can run different mappings at the same time — no interference, no toggling configs back and forth
- Model mapping and Anthropic↔OpenAI protocol conversion all happen at the gateway, transparent to clients

For concrete endpoint and mapping configuration, see `impersonator.env.example`. For a multi-session, multi-endpoint walkthrough, see [docs/multi-session-best-practices.md](docs/multi-session-best-practices.md) (Chinese).

## Deployment

- Runtime: Bun
- Management: systemd (`systemctl restart/stop/status impersonator`)
- Logs: `journalctl -u impersonator`

## Files

| File | Description |
|---|---|
| `impersonator.js` | Proxy main program |
| `converter.js` | Anthropic↔OpenAI protocol conversion module |
| `impersonator.env.example` | Configuration example (annotated) |
| `impersonator.service` | systemd service unit file |
| `test-converter.js` | Protocol conversion unit tests |
