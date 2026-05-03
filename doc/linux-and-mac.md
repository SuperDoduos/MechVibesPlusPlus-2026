# MechVibes++ 2026 FAQ
## Linux and macOS

Linux and macOS builds are not publicly available from this fork.

This is because release builds need to be created on machines running the target operating system.

## Can I make a version myself?

Yes.

**What you'll need**

- [Visual Studio Code](https://code.visualstudio.com/)
- [Node.js](https://nodejs.org/)
- A machine running your desired OS
  - For example, if you're trying to build a Mac version, you'll need a Mac.
- JavaScript knowledge
  - You may need to fix platform-specific runtime issues.

## How to do it

1. Install Node.js and Visual Studio Code.
2. Download this source code.
3. Open the project folder in Visual Studio Code.
4. At the top, click **Terminal** then **New Terminal**.
5. Run `npm install`.
6. If you're building for Linux, run `npm run build:linux`.
7. If you're building for macOS, run `npm run build:mac`.
8. Wait for the build to finish.
9. Run the app and use the developer console to check for errors.

If you need additional help, use the project Discord. Remember that maintainers may not have access to every target operating system.
