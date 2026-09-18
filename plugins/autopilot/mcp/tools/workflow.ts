import { advanceWorkflow, OUTCOMES, type Outcome } from "../lib/routing.ts";
import { enumOf, obj, str } from "../lib/schema.ts";
import { defineTool, type AnyTool } from "../lib/tool.ts";

export const workflowTools: AnyTool[] = [defineTool({
  name: "advance-workflow",
  description: "Applique le verdict d'une etape : route vers le prochain agent, incremente les compteurs et escalade au plafond. Les transitions et budgets sont executes par le serveur. Ne recalcule pas le prochain point a la main.",
  inputSchema: obj({
    ticketId: str("Cle Jira du run."),
    expectedStep: str("Curseur qui a produit ce verdict, par exemple 10.5. Une repetition sur une autre etape est refusee."),
    outcome: enumOf("Verdict structure de l'agent qui vient de rendre la main.", OUTCOMES),
    testId: str("Identifiant du test conteste, requis pour dispute."),
  }, ["ticketId", "expectedStep", "outcome"]),
  handler: ({ ticketId, expectedStep, outcome, testId }: { ticketId: string; expectedStep: string; outcome: Outcome; testId?: string }) => advanceWorkflow(ticketId, expectedStep, outcome, testId),
})];
