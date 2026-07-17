This a repo for a discord bot that reports newly completed matches of video games for opted in discord users

## General Points

- Do not write code unless explicitly asked - default to review and suggest code unless warranted otherwise
- Simplicity and maintainability over all else
- If a simpler approach exists, say so and push back when warranted
- If something is unclear stop and ask, don't make many assumptions
- Goal of project is to create a match reporting discord bot that is game agnostic (extendable other games with minimal code changes)

## Project Structure

- Written in TypeScript with the Effect v4 library, use it wherever you can and idiomatically
- Use pnpm and related tools
- The core pieces of the project are: entry point src/index.ts file, the match polling loop src/polling.ts, and the various effect services in src/services such as SQLite, video game APIs, and the Match Engine used in the polling loop
