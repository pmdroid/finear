import { LinearClient } from "@linear/sdk";

const apiUrl = new URL("/graphql", process.env.FINEAR_URL ?? "http://127.0.0.1:4444").href;
const client = new LinearClient({
  apiUrl,
  ...(process.env.LINEAR_ACCESS_TOKEN
    ? { accessToken: process.env.LINEAR_ACCESS_TOKEN }
    : { apiKey: process.env.LINEAR_API_KEY ?? "finear-fixture-primary-key" }),
});
const viewer = await client.viewer;
const team = (await client.teams()).nodes[0];
if (!team) throw new Error("The authenticated identity has no accessible team");
const project = (await (
  await client.createProject({ name: "Example project", teamIds: [team.id] })
).project)!;
const parent = (await (
  await client.createIssue({ title: "Example parent", teamId: team.id, projectId: project.id })
).issue)!;
for (const title of ["First child", "Second child"]) {
  await client.createIssue({ title, teamId: team.id, projectId: project.id, parentId: parent.id });
}
await client.createComment({
  issueId: parent.id,
  body: "Created through the unchanged Linear SDK",
});
console.log(
  JSON.stringify(
    {
      viewer: viewer.name,
      project: project.id,
      parent: parent.identifier,
      children: (await parent.children()).nodes.map((issue) => issue.identifier),
    },
    null,
    2,
  ),
);
