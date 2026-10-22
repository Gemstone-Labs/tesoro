import type { Meta } from "@storybook/nextjs-vite";
import type { StoryObj } from "@storybook/nextjs-vite";
import { userEvent, within } from "storybook/test";
import { docStory } from "./support/docs";

const meta = {
  title: "Screens/Docs",
  parameters: { layout: "fullscreen", shell: "docs" },
} satisfies Meta;
export default meta;

/** Each Docs page in the docs layout. The toolbar Theme switch flips light and dark. */
export const Overview = docStory("/docs");
export const HowItWorks = docStory("/docs/how-it-works");
export const Accounts = docStory("/docs/accounts");
export const Positions = docStory("/docs/positions");
export const Gemas = docStory("/docs/gemas");
export const Matches = docStory("/docs/matches");
export const Backing = docStory("/docs/backing");
export const Leaderboard = docStory("/docs/leaderboard");
export const Fees = docStory("/docs/fees");
export const Chains = docStory("/docs/chains");
export const Fairness = docStory("/docs/fairness");
export const Risks = docStory("/docs/risks");
export const Architecture = docStory("/docs/developers");
export const DevPrograms = docStory("/docs/developers/programs");
export const DevSettlement = docStory("/docs/developers/settlement");
export const DevRollups = docStory("/docs/developers/rollups");
export const DevCrossChain = docStory("/docs/developers/cross-chain");

const search = (text: string): StoryObj["play"] => async ({ canvasElement }) => {
  await userEvent.type(await within(canvasElement).findByRole("searchbox", { name: "Search the docs" }), text);
};

/** Typing "fees" in the header search opens the list of matching pages. */
export const SearchResults: StoryObj = { ...docStory("/docs"), play: search("fees") };

/** Typing something no page covers: "No page matches ...". */
export const SearchNoResults: StoryObj = { ...docStory("/docs"), play: search("zzzqxv") };
