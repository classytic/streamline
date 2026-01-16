# Contributing to Streamline

Thanks for your interest in contributing! 🎉

## How to Contribute

### 1. Report Bugs

Found a bug? [Open an issue](https://github.com/classytic/streamline/issues/new) with:
- What you expected to happen
- What actually happened
- Code to reproduce the issue
- Your environment (Node version, OS)

### 2. Suggest Features

Have an idea? [Open an issue](https://github.com/classytic/streamline/issues/new) with:
- What problem it solves
- How you envision it working
- Example code (if applicable)

### 3. Submit Code

**Step-by-step:**

```bash
# 1. Fork the repo on GitHub (click Fork button)

# 2. Clone YOUR fork (not the main repo)
git clone https://github.com/YOUR_USERNAME/streamline.git
cd streamline

# 3. Create a branch for your changes
git checkout -b fix-something

# 4. Install dependencies
npm install

# 5. Make your changes
# Edit files...

# 6. Run tests
npm test

# 7. Build to verify
npm run build

# 8. Commit your changes
git add .
git commit -m "Fix: description of what you fixed"

# 9. Push to YOUR fork
git push origin fix-something

# 10. Go to GitHub and click "Create Pull Request"
```

## Commit Message Format

Use conventional commits:

```
feat: add new feature
fix: fix a bug
docs: update documentation
test: add tests
refactor: refactor code
chore: update dependencies
```

Examples:
- `feat: add webhook trigger support`
- `fix: resolve race condition in executor`
- `docs: improve README examples`

## Development Setup

```bash
# Install dependencies
npm install

# Run tests in watch mode
npm run test:watch

# Build
npm run build

# Type check
npm run typecheck
```

## Code Style

- Use TypeScript
- Follow existing code style
- Add JSDoc comments for public APIs
- Write tests for new features
- Keep PRs focused (one feature/fix per PR)

## What to Contribute

**Good first issues:**
- Fix typos in docs
- Add examples
- Improve error messages
- Add tests for untested code

**Bigger contributions:**
- New features (discuss in issue first!)
- Performance improvements
- Bug fixes

**Before big changes:**
- Open an issue first to discuss
- Wait for maintainer approval
- Then start coding

## Review Process

1. You submit PR
2. Maintainer reviews (usually within 3 days)
3. You fix requested changes
4. Maintainer merges
5. Your code ships in next release!

## Questions?

Open an issue or tag @maintainer in discussions.

Thank you for contributing! 🚀
