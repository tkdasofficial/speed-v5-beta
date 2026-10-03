import { describe, expect, it } from "vitest";
import { extractProjectMetadata as x } from "./project-name";

describe("extractProjectMetadata", () => {
  it("website named quoted", () => expect(x('Build a website named "NEXORA" for a premium technology company.')).toEqual({ projectName: "NEXORA", appName: null, websiteName: "NEXORA" }));
  it("project called", () => expect(x("Create a project called FlowPilot.").projectName).toBe("FlowPilot"));
  it("project named unquoted", () => expect(x("Create a project named NEXORA").projectName).toBe("NEXORA"));
  it("this project is called", () => expect(x("This project is called NEXORA").projectName).toBe("NEXORA"));
  it("website name is", () => expect(x("The website name is NEXORA").websiteName).toBe("NEXORA"));
  it("label colon", () => expect(x("Project Name: NEXORA\nMake it dark").projectName).toBe("NEXORA"));
  it("project colon", () => expect(x("Project: NEXORA").projectName).toBe("NEXORA"));
  it("app label + single quotes", () => { expect(x("App Name: FlowPilot").appName).toBe("FlowPilot"); expect(x("Build an app called 'FlowPilot'").appName).toBe("FlowPilot"); });
  it("project beats website", () => expect(x('Project Name: Alpha. Build a website named "Beta"').projectName).toBe("Alpha"));
  it("no explicit name", () => expect(x("Build a modern business website for a technology company.")).toEqual({ projectName: null, appName: null, websiteName: null }));
  it("ignores stopwords", () => expect(x("Build a website called a portfolio").websiteName).toBeNull());
});
