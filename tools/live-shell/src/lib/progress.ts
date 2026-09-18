/** Vocabulaire d'etat partage par les composants et les selecteurs purs. */
export type Progress = "todo" | "running" | "idle" | "human" | "error" | "done";
export type RunMark = Exclude<Progress, "todo">;
