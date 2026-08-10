This a repo for a discord bot that reports newly completed matches of video games for opted in discord users

## General Points

- Respond concisely unless told otherwise
- Do not write code unless explicitly asked - default to review and suggesting code snippets
- Simplicity and maintainability over all else
- If a simpler approach exists, say so and push back when warranted
- If something is unclear stop and ask, don't make many assumptions
- Goal of project is to create a match reporting discord bot that is game agnostic (extendable other games with minimal code changes)

## Taste

- Re-use the Effect pieces as much as possible
- Inferred types over annotations. `any` is the enemy
- Comments describe how a thing is used, and move when the code moves. To be used mostly to describe functions, not to annotate every line of behavior
- If a rule here fights the task in front of you, say so loudly and get a human sign-off before breaking it

## Pull Requests

- Never make a PR unless the developer explicitly asks you to do so
- Conventional commit titles, plain language: `fix(web): new threads no longer spike CPU`
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work

## Project Structure

- Written in TypeScript with the Effect v4 library, use it wherever you can and idiomatically with the effect skill
- Use pnpm and related tools
- The core pieces of the project are: entry point src/index.ts file and the various effect services in src/services such as SQLite, video game APIs, the Match Engine, the Polling, etc.
