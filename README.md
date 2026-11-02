# Butler

A self-hosted voice assistant with a living particle avatar. Bring any OpenAI-compatible model and talk to it in your browser.

![Short recording: the avatar condenses into a cube while thinking, then an alpha while speaking](docs/demo.gif)

- **Talk or type:** hold click or space to speak, say the wake word, or use the chat box.
- **Any model:** Ollama, OpenAI or anything with a streaming `/chat/completions`.
- **Answers out loud:** it starts speaking while the model is still writing.
- **Tools:** connect MCP servers and the model can use them.

Built with Nuxt, Vue, TypeScript and three.js.

## Run it

You need Node 22 or newer and [pnpm](https://pnpm.io).

```bash
pnpm install
cp .env.example .env
```

Point `.env` at your model, then start it:

```bash
# .env, for Ollama
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=qwen2.5:7b
```

```bash
pnpm dev
```

Open <http://localhost:3000>. For a hosted provider, change the base URL and model and add `LLM_API_KEY`.

For voice, set `STT_BASE_URL` and `TTS_BASE_URL` to anything with OpenAI-style audio endpoints, such as [Speaches](https://github.com/speaches-ai/speaches). `.env.example` lists every option.

Tool support varies by model. If replies wander, try a stronger model.

## Tools

Set `MCP_SERVERS` to JSON, or to a path to a JSON file:

```json
{
  "time": { "command": "uvx", "args": ["mcp-server-time"] },
  "notes": { "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer your-token" } }
}
```

## Safety

Butler has no login unless you set `AUTH_USER` and `AUTH_PASS`, so keep it on a trusted network.

## License

MIT. See [LICENSE](LICENSE).
