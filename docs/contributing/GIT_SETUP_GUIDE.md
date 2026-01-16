# Git Setup & Contribution Guide

## Step 1: Initialize Git (First Time)

```bash
# In your streamline directory
cd d:\projects\packages\streamline

# Initialize git
git init

# Create .gitignore if not exists
cat > .gitignore << EOF
node_modules/
dist/
*.log
.env
.DS_Store
coverage/
EOF

# Add all files
git add .

# First commit
git commit -m "Initial commit: Streamline v0.1.0"
```

## Step 2: Create GitHub Repository

**On GitHub.com:**

1. Go to https://github.com/new
2. Repository name: `streamline`
3. Description: "MongoDB-native workflow engine - like Temporal but simpler"
4. Public (for open source)
5. DON'T initialize with README (you already have files)
6. Click "Create repository"

**Connect Local to GitHub:**

```bash
# Add GitHub as remote (replace YOUR_USERNAME)
git remote add origin https://github.com/YOUR_USERNAME/streamline.git

# Verify
git remote -v

# Push to GitHub
git branch -M main
git push -u origin main
```

Now your code is on GitHub!

## Step 3: Tag Version 0.1.0

```bash
# Create tag
git tag -a v0.1.0 -m "Initial release v0.1.0"

# Push tag
git push origin v0.1.0

# Verify
git tag -l
```

GitHub will show "v0.1.0" under Releases.

## Step 4: Create GitHub Release

**On GitHub:**

1. Go to your repo → Releases → "Create a new release"
2. Choose tag: v0.1.0
3. Title: "v0.1.0 - Initial Release"
4. Description: Copy from CHANGELOG.md
5. Click "Publish release"

Now it looks official! ✨

## How People Find & Contribute

### Discovery

People find your package via:
1. **npm search** - searching "workflow mongodb"
2. **GitHub search** - searching repos
3. **Reddit/Twitter** - you post about it
4. **Word of mouth** - users recommend it

### Contribution Flow

**What happens:**

1. **User finds issue** → Opens GitHub issue
   ```
   Title: "Bug: workflow crashes on large context"
   Description: Explain the problem
   ```

2. **You respond** → "Thanks! Want to fix it? Check CONTRIBUTING.md"

3. **User forks** → Clicks "Fork" on GitHub
   - Creates: `github.com/THEIR_USERNAME/streamline` (their copy)

4. **User makes changes** → On their fork
   ```bash
   git clone https://github.com/THEIR_USERNAME/streamline.git
   git checkout -b fix-crash
   # Make changes
   git commit -m "fix: resolve crash on large context"
   git push origin fix-crash
   ```

5. **User opens Pull Request (PR)**
   - GitHub shows button: "Compare & pull request"
   - PR appears on YOUR repo under "Pull requests" tab

6. **You review** → See the changes on GitHub
   - Comment: "Looks good but please add a test"
   - OR: "LGTM!" (Looks Good To Me)

7. **You merge** → Click "Merge pull request" button
   - Their code is now in YOUR repo!
   - They get credit automatically (shows as contributor)

8. **Release new version** → (See below)

## How to Release New Versions

### Version Numbers (Semantic Versioning)

```
v0.1.0 → v0.1.1 (patch - bug fix)
v0.1.0 → v0.2.0 (minor - new feature)
v0.1.0 → v1.0.0 (major - breaking change)
```

### Release Process

**Example: Someone fixed a bug, you want to release v0.1.1**

```bash
# 1. Pull latest changes
git pull origin main

# 2. Update version in package.json
# Change "version": "0.1.0" → "0.1.1"

# 3. Update CHANGELOG.md
cat >> CHANGELOG.md << EOF

## [0.1.1] - 2025-01-20

### Fixed
- Fixed crash on large context (thanks @contributor)
EOF

# 4. Commit
git add package.json CHANGELOG.md
git commit -m "chore: bump version to 0.1.1"

# 5. Create tag
git tag -a v0.1.1 -m "Release v0.1.1"

# 6. Push
git push origin main
git push origin v0.1.1

# 7. Publish to npm
npm run build
npm publish

# 8. Create GitHub release
# Go to GitHub → Releases → "Create release" → v0.1.1
```

Done! v0.1.1 is now live on:
- npm: `npm install @classytic/streamline@0.1.1`
- GitHub: Shows under Releases

## How You Know When Someone Wants to Contribute

### GitHub Notifications

You get email/notification when:
- ✉️ Someone opens an issue
- ✉️ Someone opens a PR
- ✉️ Someone stars your repo
- ✉️ Someone forks your repo

**Enable notifications:**
1. Go to repo on GitHub
2. Click "Watch" → "All Activity"
3. You'll get emails for everything

### Checking Activity

```bash
# See who forked your repo
https://github.com/YOUR_USERNAME/streamline/network/members

# See pull requests
https://github.com/YOUR_USERNAME/streamline/pulls

# See issues
https://github.com/YOUR_USERNAME/streamline/issues
```

## Daily Workflow (After Launch)

### Morning Routine

```bash
# Check GitHub notifications
# Visit: https://github.com/notifications

# Check npm downloads
# Visit: https://www.npmjs.com/package/@classytic/streamline

# Pull latest (if others contributed)
git pull origin main
```

### When Someone Opens Issue

1. Read the issue
2. Respond within 24-48 hours
3. Options:
   - "Good idea! Want to implement? See CONTRIBUTING.md"
   - "I'll fix this, thanks for reporting!"
   - "This won't work because..."

### When Someone Opens PR

1. Review the code on GitHub
2. Test locally if needed:
   ```bash
   # Fetch their branch
   git fetch origin pull/123/head:pr-123
   git checkout pr-123
   npm install
   npm test
   ```
3. Comment on changes needed OR merge
4. Thank them!

## Example: First Contribution

**Scenario: Someone fixes a typo in README**

**1. They fork & change:**
```bash
# On their computer
git clone https://github.com/CONTRIBUTOR/streamline.git
git checkout -b fix-typo
# Edit README.md
git commit -m "docs: fix typo in README"
git push origin fix-typo
```

**2. They open PR on GitHub**
- PR appears under your repo's "Pull requests"

**3. You see notification:**
- Email: "New pull request: Fix typo in README"

**4. You review on GitHub:**
- Click the PR
- See the diff (what changed)
- Looks good!

**5. You merge:**
- Click "Merge pull request"
- Click "Confirm merge"

**6. Done!**
- Their change is in your main branch
- They show up as contributor automatically
- You can thank them in the PR comments

## Contributor Recognition

GitHub automatically tracks:
- Who contributed (shows avatars)
- How many commits
- When they contributed

**You don't need to do anything!** GitHub handles it.

## Best Practices

### DO:
✅ Respond to issues within 48 hours
✅ Thank contributors
✅ Add "good first issue" labels for beginners
✅ Keep CHANGELOG updated
✅ Release often (even small fixes)

### DON'T:
❌ Add people as collaborators (use fork model)
❌ Merge without reviewing
❌ Leave issues/PRs open for months
❌ Forget to thank contributors

## Quick Reference

```bash
# Check status
git status

# See commits
git log --oneline

# See tags
git tag -l

# Create new version
git tag -a v0.2.0 -m "Release v0.2.0"
git push origin v0.2.0

# Pull latest
git pull origin main

# See who contributed
git shortlog -sn
```

## First Week After Launch

**Day 1:** Publish to npm, post on Reddit/Twitter
**Day 2-3:** Respond to initial feedback
**Day 4-7:** Watch for issues, engage with users

**Don't expect contributions immediately!**
- First week: Issues/questions
- First month: Maybe 1-2 PRs
- After 100+ stars: More regular contributions

## Summary

**You own the repo** → Nobody else can push directly

**Contributors fork** → Work on their copy

**They send PR** → You review and merge

**You release** → Tag + npm publish

**GitHub handles** → Tracking contributors, notifications

That's it! You're the maintainer, they're the contributors. Simple! 🚀
