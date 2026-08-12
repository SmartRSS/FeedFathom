---
layout: default
title: Contributing
nav_order: 4
---

# Contributing to FeedFathom

## Getting Started

1. Fork the repository
2. Create a feature branch:
```bash
git checkout -b feature-branch-name
```

3. Make your changes
4. Commit your changes:
```bash
git commit -m 'Add feature'
```

5. Push to your fork:
```bash
git push origin feature-branch-name
```

6. Create a Pull Request

## Guidelines

- Follow existing code style
- Add tests for new features
- Update documentation as needed
- Keep commits focused and meaningful
- Run the complete gate before opening a pull request:

```bash
bun run quality
```

Use `bun run test:unit`, `bun run test:browser`, or `bun run lint` while iterating. Browser tests require the Chromium binary installed by `bunx playwright install chromium`.

## License

This project is licensed under the MIT License.

## Acknowledgements

- [Remix Icon](https://remixicon.com/) - Apache License 2.0
- [Bun](https://bun.sh) - JavaScript runtime
- [Solid](https://www.solidjs.com/) and [Elysia](https://elysiajs.com/) - Web UI and API framework
