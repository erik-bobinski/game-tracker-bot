// The bot's public pages: what Discord and Riot link to as the product's site,
// terms and privacy policy, and where a riot sign-in lands.

import {
  linkMessage,
  setupChannelMessage,
  signedUpMessage,
  trackPrompt,
} from "../discord/commands.ts";
import { gameNames, type GameId } from "../game/index.ts";

const SOURCE_URL = "https://github.com/erik-bobinski/game-tracker-bot";
const UPDATED = "October 10, 2026";

export interface Site {
  readonly name: string;
  readonly inviteUrl: string;
  // games added by signing in with riot through /link, if it's offered
  readonly linkGames: ReadonlyArray<string>;
}

// riot ids and other names are player-chosen, so never trusted as markup
export const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const listGames = (games: ReadonlyArray<string>) =>
  games.length > 1
    ? `${games.slice(0, -1).join(", ")} and ${games.at(-1)}`
    : (games[0] ?? "");

const page = (site: Site, title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #16171b; color: #f2f3f5; font: 16px/1.6 system-ui, sans-serif; }
  main { max-width: 680px; margin: 0 auto; padding: 48px 20px; }
  h1 { font-size: 2rem; margin: 0 0 8px; }
  h2 { font-size: 1.15rem; margin: 32px 0 8px; }
  a { color: #8ab4ff; }
  code { background: #272b35; padding: 1px 6px; border-radius: 4px; }
  .lead { color: #c8cbd1; font-size: 1.1rem; }
  h3 { font-size: 1rem; margin: 24px 0 4px; }
  figure { margin: 12px 0 24px; }
  figcaption { color: #9a9ea6; font-size: 0.9rem; margin-top: 6px; }
  .message { background: #2b2d31; border-radius: 8px; padding: 12px 16px; margin: 12px 0; }
  .message p { margin: 4px 0; }
  .message img { display: block; width: 100%; height: auto; margin-top: 8px; border-radius: 10px; }
  .message small { display: block; color: #9a9ea6; margin-bottom: 4px; }
  .message .author { color: #c9cdfb; }
  .message .button { margin: 8px 0 0; padding: 6px 16px; background: #4e5058; }
  .message .select { display: block; margin-top: 8px; padding: 8px 12px; border-radius: 4px; background: #1e1f22; color: #b5bac1; }
  .button { display: inline-block; margin: 16px 0; padding: 10px 22px; border-radius: 6px; background: #5865f2; color: #fff; text-decoration: none; font-weight: 600; }
  footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid #2c2f36; color: #9a9ea6; font-size: 0.85rem; }
</style>
</head>
<body>
<main>
${body}
<footer>
<p><a href="/">${escapeHtml(site.name)}</a> · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> · <a href="${SOURCE_URL}">Source</a></p>
<p>${escapeHtml(site.name)} isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games, and all associated properties are trademarks or registered trademarks of Riot Games, Inc.</p>
</footer>
</main>
</body>
</html>`;

// discord's **bold** and `code`, for quoting the bot's messages
const discordText = (text: string) =>
  escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.+?)`/g, "<code>$1</code>");

// a discord message as the walkthrough shows it; `only` is whom an ephemeral
// reply is visible to
const message = (author: string, body: string, only?: string) =>
  `<div class="message">${only ? `<small>Only ${only} can see this</small>` : ""}<strong class="author">${escapeHtml(author)}</strong>${body}</div>`;

const demoCaptions = {
  lol: "A ranked League of Legends game: both teams' champions, KDA, CS, damage and ranks, with the LP each signed-up player gained or lost.",
  tft: "A ranked Teamfight Tactics game: all eight placements with each player's level and rank.",
  valorant:
    "A competitive VALORANT game: only the players who signed in with Riot are named and ranked. Everyone else shows as their agent and stats.",
} satisfies Record<GameId, string>;

export interface Demo {
  readonly game: GameId;
  // the text posted with the card
  readonly summary: string;
}

const demoReport = (site: Site, { game, summary }: Demo) =>
  `<figure>${message(site.name, `<p>${discordText(summary)}</p><img src="/demo/${game}.png" alt="Example ${escapeHtml(gameNames[game])} match report">`)}<figcaption>${escapeHtml(demoCaptions[game])}</figcaption></figure>`;

export const landingPage = (site: Site, demos: ReadonlyArray<Demo>) => {
  const name = escapeHtml(site.name);
  const [first, ...rest] = demos;
  return page(
    site,
    site.name,
    `<h1>${name}</h1>
<p class="lead">Posts League of Legends, Teamfight Tactics and VALORANT results to your Discord server as soon as a signed-up player finishes a game.</p>
<a class="button" href="${escapeHtml(site.inviteUrl)}">Add to Discord</a>
<h2>How it works</h2>
<p>From adding the bot to its first report. The bot's messages are quoted as it sends them; the matches are samples with made-up players.</p>
<h3>1. The bot joins a server</h3>
<p>A server admin adds it with <strong>Add to Discord</strong>, then runs <code>/setup</code> to pick the channel reports go to. The bot posts there to check it can:</p>
${message(site.name, `<p>${discordText(setupChannelMessage)}</p>`)}
<h3>2. A player signs up</h3>
<p>Anyone in the server runs <code>/signup</code> with their Riot ID, here <code>/signup riot_name:DevPlayer1 riot_tag:DEV</code>, and picks which games to report:</p>
${message(site.name, `<p>${discordText(signedUpMessage("Alex"))}</p>`)}
${message(site.name, `<p>${discordText(trackPrompt)}</p><span class="select">${escapeHtml(Object.values(gameNames).join(", "))}</span>`, "you")}${
      site.linkGames.length > 0
        ? `\n<p>For ${escapeHtml(listGames(site.linkGames))}, they also sign in with Riot through <code>/link</code>, as shown below.</p>`
        : ""
    }
<p>Anyone can stop with <code>/signout</code>, and server admins can <code>/pause</code> reports.</p>
<h3>3. They finish a game</h3>
<p>Shortly after the game ends, the bot posts its scoreboard in the report channel. Players from the server who were in the same game share one post, and their rows are highlighted.</p>
${first ? demoReport(site, first) : ""}
${rest.length > 0 ? `<p>The other games are reported the same way:</p>\n${rest.map((demo) => demoReport(site, demo)).join("\n")}` : ""}
<h2>VALORANT opt-in</h2>
<p>VALORANT matches are only reported for players who sign in with Riot (RSO) to opt in:</p>
<ol>
<li>The player runs <code>/link</code> in a server and gets this reply:
${message(site.name, `<p>${discordText(linkMessage("VALORANT"))}</p><span class="button">Sign in with Riot</span>`, "you")}</li>
<li>They sign in on Riot's page, and land back here on a page confirming which Riot ID was linked.</li>
<li>The bot records when they opted in and starts reporting their VALORANT matches in that server. <code>/signout</code> stops it and deletes their data.</li>
</ol>`,
  );
};

export const termsPage = (site: Site) => {
  const name = escapeHtml(site.name);
  return page(
    site,
    `${site.name} terms of service`,
    `<h1>Terms of service</h1>
<p>Last updated ${UPDATED}.</p>
<p>By adding ${name} to a Discord server or using its commands, you agree to these terms.</p>
<h2>The service</h2>
<p>${name} is a free Discord bot that reports the League of Legends, Teamfight Tactics and VALORANT matches of players who sign up. It is provided as is, without any warranty, and may change, break or stop at any time.</p>
<h2>Using it</h2>
<ul>
<li>Only sign up or link Riot accounts that are yours.</li>
<li>Don't use the bot to harass anyone, or to get around Riot's or Discord's rules.</li>
<li>Server admins decide which channel reports go to and can pause them.</li>
</ul>
<p>Anyone who misuses the bot can be removed from it.</p>
<h2>Other terms</h2>
<p>Your use of Discord and of Riot's games stays covered by the <a href="https://discord.com/terms">Discord Terms of Service</a> and the <a href="https://www.riotgames.com/en/terms-of-service">Riot Games Terms of Service</a>.</p>
<h2>Liability</h2>
<p>As far as the law allows, the people who run ${name} aren't liable for anything that comes from using it.</p>
<h2>Contact</h2>
<p>Questions go to <a href="${SOURCE_URL}/issues">the project's issue tracker</a>.</p>`,
  );
};

export const privacyPage = (site: Site) => {
  const name = escapeHtml(site.name);
  return page(
    site,
    `${site.name} privacy policy`,
    `<h1>Privacy policy</h1>
<p>Last updated ${UPDATED}.</p>
<p>${name} is a Discord bot that posts the match results of players who sign up to the Discord servers they signed up in. This is what it keeps and why.</p>
<h2>What it stores</h2>
<ul>
<li><strong>Your Discord account:</strong> your user ID, the username you had when you signed up, and the servers you signed up in.</li>
<li><strong>Your Riot account:</strong> your Riot ID, and for each game you play, Riot's player ID for you and your region, the IDs and start times of your last ten reported matches, your last rank in each ranked queue, and, for games that need it, when you signed in with Riot to opt in.</li>
<li><strong>Each server:</strong> its ID, the channel reports go to, and whether they're paused.</li>
</ul>
<p>It doesn't store match details, your Riot password, Riot sign-in tokens or your email. Signing in with Riot only tells the bot which Riot account is yours; the sign-in is discarded right after.</p>
<h2>What it shows</h2>
<p>When you finish a game, the bot posts the game's scoreboard, as Riot publishes it, in the channel of each server you signed up in: your name, champion or agent, stats and rank, and those of the other players in the game. Anyone who can read that channel can see it. Signing up, or linking your Riot account, makes your match data visible to the members of those servers.</p>
<h2>Who else handles it</h2>
<ul>
<li>Riot Games' API, which the bot reads accounts, matches and ranks from.</li>
<li>Discord, which carries commands and reports.</li>
<li>Railway, which hosts the bot and its database.</li>
</ul>
<p>Report images include game art from public asset sites; no personal data is sent to them.</p>
<h2>How long it keeps it</h2>
<p>Your data is deleted once no server reports your matches anymore: when you run <code>/signout</code> in the last server you signed up in, or the bot leaves it. A server's settings are deleted when the bot leaves it. The host keeps operational logs, which can include Discord and Riot IDs, for a short time.</p>
<h2>Your choices</h2>
<p>Run <code>/signout</code> to stop reporting in a server. To ask about your data or have it deleted, open an issue on <a href="${SOURCE_URL}/issues">the project's issue tracker</a>.</p>
<h2>Age</h2>
<p>Like Discord, the bot is for people at least 13 years old, or older where local law requires.</p>
<h2>Changes</h2>
<p>Changes to this policy are posted on this page.</p>`,
  );
};

export const resultPage = (site: Site, title: string, message: string) =>
  page(site, title, `<h1>${escapeHtml(title)}</h1>\n<p>${message}</p>`);
