import { REST, Routes } from "discord.js";

const commands = [
  {
    name: "ping",
    description: "Replies with pong!",
  },
];

const rest = new REST({ version: "10" }).setToken(
  process.env.DISCORD_TOKEN ?? "",
);

try {
  console.log("Started refreshing the application (/) commands.");

  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID ?? ""), {
    body: commands,
  });
} catch (e) {
  console.error(e);
}
