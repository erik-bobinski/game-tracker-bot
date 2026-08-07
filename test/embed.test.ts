import { describe, expect, it } from "vitest";
import { matchEmbed, rankEmbed } from "../src/services/discord/embed.ts";
import { EpochMillis, MatchId, Puuid } from "../src/services/game/index.ts";

describe("match embeds", () => {
  it("renders valid UTF-8 without mojibake", () => {
    const embed = matchEmbed(
      {
        discordNames: ["One", "Two"],
        trackedPuuids: ["one"],
        match: {
          matchId: MatchId.make("match"),
          game: "lol",
          date: EpochMillis.make(1_000),
          mode: "Ranked Solo/Duo",
          map: "Summoner's Rift",
          durationSeconds: 1_234,
          surrendered: false,
          players: [
            {
              puuid: Puuid.make("one"),
              team: "100",
              riotName: "Mock",
              riotTag: "NA1",
              character: "Ahri",
              kills: 20,
              deaths: 1,
              assists: 9,
              stat: "200 CS · 30k dmg",
              sortKey: 29,
              flair: "Penta Kill",
            },
          ],
          teams: [{ id: "100", won: true, score: [13, 8] }],
        },
      },
      {},
    );
    const rendered = `${embed.title}\n${embed.description}\n${JSON.stringify(embed.fields)}`;
    expect(rendered).toContain("Victory — Ranked Solo/Duo · Summoner's Rift");
    expect(rendered).toContain("13–8");
    expect(embed.description).toContain("**Penta Kill** — Mock#NA1");
    expect(embed.fields).toEqual([
      {
        name: "Your team — 13",
        value: "**Mock#NA1** · Ahri · 20/1/9 · 200 CS · 30k dmg",
        inline: false,
      },
    ]);
    expect(rendered).not.toMatch(/Â|â€|ðŸ/);
  });
  it("keeps each player's identity and stats together in mobile-first team fields", () => {
    const player = (overrides: {
      puuid: string;
      team: string;
      riotName: string;
      character: string;
      kills: number;
      sortKey: number;
    }) => ({
      puuid: Puuid.make(overrides.puuid),
      team: overrides.team,
      riotName: overrides.riotName,
      riotTag: "NA1",
      character: overrides.character,
      kills: overrides.kills,
      deaths: 2,
      assists: 3,
      stat: "100 CS · 10k dmg",
      sortKey: overrides.sortKey,
    });
    const embed = matchEmbed(
      {
        discordNames: ["One"],
        trackedPuuids: ["tracked"],
        match: {
          matchId: MatchId.make("two-teams"),
          game: "lol",
          date: EpochMillis.make(1_000),
          mode: "Ranked Solo/Duo",
          durationSeconds: 1_234,
          surrendered: false,
          players: [
            player({
              puuid: "ally",
              team: "100",
              riotName: "AllyLow",
              character: "Lux",
              kills: 1,
              sortKey: 1,
            }),
            player({
              puuid: "tracked",
              team: "100",
              riotName: "AVeryLongRiotNameIndeed",
              character: "Ahri",
              kills: 20,
              sortKey: 29,
            }),
            player({
              puuid: "enemy",
              team: "200",
              riotName: "Enemy",
              character: "Garen",
              kills: 5,
              sortKey: 5,
            }),
          ],
          teams: [
            { id: "100", won: true },
            { id: "200", won: false },
          ],
        },
      },
      {},
    );

    expect(embed.fields).toEqual([
      {
        name: "Your team — Victory",
        value:
          "**AVeryLongRiotName…** · Ahri · 20/2/3 · 100 CS · 10k dmg\n" +
          "AllyLow#NA1 · Lux · 1/2/3 · 100 CS · 10k dmg",
        inline: false,
      },
      {
        name: "Opponent — Defeat",
        value: "Enemy#NA1 · Garen · 5/2/3 · 100 CS · 10k dmg",
        inline: false,
      },
    ]);
  });
  it("uses rank emojis without redundant rank labels in leaderboards", () => {
    const league = matchEmbed(
      {
        discordNames: ["One"],
        trackedPuuids: ["one"],
        match: {
          matchId: MatchId.make("league-rank"),
          game: "lol",
          date: EpochMillis.make(1_000),
          mode: "Ranked",
          durationSeconds: 1_234,
          surrendered: false,
          players: [
            {
              puuid: Puuid.make("one"),
              team: "100",
              riotName: "Mock",
              riotTag: "NA1",
              character: "Ahri",
              kills: 20,
              deaths: 1,
              assists: 9,
              stat: "200 CS",
              rank: "Diamond II",
              rankIconKey: "diamond",
              sortKey: 29,
            },
          ],
          teams: [{ id: "100", won: true }],
        },
      },
      { "lol.diamond": "<:diamond:1>" },
    );
    expect(league.fields?.[0]?.value).toContain(
      "<:diamond:1> II **Mock#NA1** · Ahri · 20/1/9 · 200 CS",
    );
    expect(JSON.stringify(league)).not.toContain("Diamond II");

    const valorant = matchEmbed(
      {
        discordNames: ["One"],
        trackedPuuids: ["one"],
        match: {
          matchId: MatchId.make("valorant-rank"),
          game: "valorant",
          date: EpochMillis.make(1_000),
          mode: "Competitive",
          durationSeconds: 1_234,
          surrendered: false,
          players: [
            {
              puuid: Puuid.make("one"),
              team: "100",
              riotName: "Mock",
              riotTag: "NA1",
              character: "Jett",
              kills: 20,
              deaths: 1,
              assists: 9,
              stat: "285 ACS",
              rank: "Diamond 1",
              rankIconKey: "diamond_1",
              sortKey: 29,
            },
          ],
          teams: [{ id: "100", won: true }],
        },
      },
      { "valorant.diamond_1": "<:diamond_1:2>" },
    );
    expect(valorant.fields?.[0]?.value).toContain(
      "<:diamond_1:2> **Mock#NA1** · Jett · 20/1/9 · 285 ACS",
    );
    expect(JSON.stringify(valorant)).not.toContain("Diamond 1");
  });
  it("renders compact game-specific rank embeds", () => {
    const valorant = rankEmbed({
      _tag: "Ranks",
      discordName: "syanx_",
      game: "valorant",
      ranks: [
        {
          label: "Diamond 3",
          pointsLabel: "73 RR",
          rankIconKey: "diamond_3",
        },
      ],
      iconUrl: "https://example.test/diamond-3.png",
    });
    expect(valorant).toMatchObject({
      title: "syanx_'s Valorant Rank",
      description: "**Diamond 3** \u00b7 73 RR",
      color: 0xff4655,
      thumbnail: { url: "https://example.test/diamond-3.png" },
    });

    const league = rankEmbed({
      _tag: "Ranks",
      discordName: "syanx_",
      game: "lol",
      ranks: [
        {
          label: "Diamond II",
          queueLabel: "Ranked Solo/Duo",
          pointsLabel: "64 LP",
        },
        {
          label: "Platinum I",
          queueLabel: "Ranked Flex",
          pointsLabel: "21 LP",
        },
      ],
      iconUrl: "https://example.test/diamond.png",
    });
    expect(league.title).toBe("syanx_'s League Rank");
    expect(league.description).toContain(
      "**Diamond II** \u00b7 64 LP (Solo/Duo)",
    );
    expect(league.description).toContain("**Platinum I** \u00b7 21 LP (Flex)");
    expect(league.color).toBe(0x0ac8b9);
    expect(league.image).toEqual({
      url: "https://example.test/diamond.png",
    });
    expect(league.thumbnail).toBeUndefined();
  });
});
