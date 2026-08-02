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
    const rendered = `${embed.title}\n${embed.description}`;
    expect(rendered).toContain("Victory — Ranked Solo/Duo · Summoner's Rift");
    expect(rendered).toContain("13–8");
    expect(rendered).toContain(
      "**Mock#NA1** (Ahri) · 20/1/9 · 200 CS · 30k dmg · Penta Kill",
    );
    expect(rendered).toContain("· Penta Kill");
    expect(rendered).not.toMatch(/Â|â€|ðŸ/);
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
    expect(league.description).toContain("<:diamond:1> II · **Mock#NA1**");
    expect(league.description).not.toContain("Diamond II");

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
    expect(valorant.description).toContain("<:diamond_1:2> · **Mock#NA1**");
    expect(valorant.description).not.toContain("Diamond 1");
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
