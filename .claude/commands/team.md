---
description: Zet een volledig agent team op voor een feature of fix. Gebruik als /team <beschrijving van de taak>
argument-hint: <beschrijving van wat er moet gebeuren>
---

# Agent Team Setup

De gebruiker wil dat je een team opzet voor de volgende taak:

**Taak:** $ARGUMENTS

---

## VERPLICHTE WERKWIJZE — Volg dit EXACT

### Stap 1: TeamCreate

Maak een team aan met een korte, beschrijvende naam (kebab-case):

```
TeamCreate({ team_name: "<korte-naam>", description: "<beschrijving>" })
```

### Stap 2: Tasks aanmaken

Breek het werk op in taken via TaskCreate. Gebruik ALTIJD deze standaard pipeline:

| # | Taak | Blocked by | Agent |
|---|------|------------|-------|
| 1 | Research/explore de codebase | — | researcher |
| 2 | Implementeer de changes | 1 | implementer |
| 3 | Test (tsc --noEmit, functionaliteit) | 2 | tester |
| 4 | Update docs (README, CLAUDE.md) | 2 | docs-writer |
| 5 | Branch, commit, push, PR aanmaken (NIET mergen) | 2, 3, 4 | deployer |
| 6 | Code review op de GitHub PR met review comments | 5 | reviewer |
| 7 | PR mergen na goedkeuring | 6 | deployer |
| 8 | Wiki updaten (indien relevant) | 7 | docs-writer |

Stel dependencies in via TaskUpdate met `addBlockedBy`.

**Bij simpele taken** mag je stap 1 (research) overslaan als de scope al duidelijk is.
**Bij complexe taken** voeg extra taken toe (bijv. security review, performance test).
**Docs**: Task 4 (README/CLAUDE.md) zit altijd in de PR. Task 8 (wiki) is optioneel — alleen als de change relevant is voor de wiki.

**BELANGRIJK: De reviewer reviewt OP de GitHub PR** — niet vóór de PR bestaat. De deployer maakt eerst de PR aan, dan reviewt de reviewer met `gh pr review`, en pas daarna wordt de PR gemerged.

### Stap 3: Spawn gespecialiseerde teammates

Spawn agents via de Agent tool met `team_name` parameter. Elke agent heeft een specifieke rol.

**BELANGRIJK:**
- Gebruik ALTIJD gespecialiseerde agents per rol — combineer NOOIT implement+test+deploy in één agent
- Sla NOOIT de reviewer over, ook niet bij "simpele" changes
- Agents refereren naar de `.claude/agents/` definities voor hun gedrag
- De reviewer MOET review comments op de GitHub PR plaatsen via `gh pr review`

#### Researcher (alleen bij research-taak)
```
Agent({
  name: "researcher",
  subagent_type: "Explore",
  model: "sonnet",
  team_name: "<team-naam>",
  prompt: "Je bent de researcher voor team <naam>. <Specifieke research opdracht>. Claim Task #1, doe je onderzoek, markeer als completed, en stuur je bevindingen naar de team lead via SendMessage."
})
```

#### Implementer
```
Agent({
  name: "implementer",
  subagent_type: "general-purpose",
  model: "opus",
  team_name: "<team-naam>",
  prompt: "Je bent de implementer voor team <naam>. <Specifieke implementatie opdracht>. Workflow: check TaskList, wacht tot dependencies completed zijn, claim je taak, implementeer, run tsc --noEmit, markeer als completed, stuur resultaat naar team lead via SendMessage. Work directory: /Users/diliecat/Documents/claude-code"
})
```

#### Tester
```
Agent({
  name: "tester",
  subagent_type: "general-purpose",
  model: "opus",
  team_name: "<team-naam>",
  prompt: "Je bent de tester voor team <naam>. Workflow: check TaskList, wacht tot de implementatie-taak completed is, claim je test-taak, run: 1) npx tsc --noEmit 2) Relevante CLI/functionaliteit tests. Rapporteer resultaten naar team lead via SendMessage. Bij errors, stuur details naar implementer. Markeer als completed als alles slaagt. Work directory: /Users/diliecat/Documents/claude-code"
})
```

#### Reviewer
```
Agent({
  name: "reviewer",
  subagent_type: "general-purpose",
  model: "opus",
  team_name: "<team-naam>",
  prompt: "Je bent de code reviewer voor team <naam>. Jouw taak is om de GitHub PR te reviewen met ECHTE review comments, net als een echt teamlid.

Workflow:
1. Check TaskList — wacht tot de PR-aanmaak-taak completed is
2. Claim je review-taak
3. Haal het PR-nummer op: run `gh pr list --head <branch-naam>` of lees het bericht van de deployer
4. Bekijk de PR diff: `gh pr diff <nummer>`
5. Lees CLAUDE.md voor project conventions
6. Review de code op: kwaliteit, security, CLAUDE.md compliance, type safety, geen regressies
7. Post je review op GitHub:
   - Bij goedkeuring: `gh pr review <nummer> --approve --body 'Review comment met bevindingen'`
   - Bij problemen: `gh pr review <nummer> --request-changes --body 'Wat er mis is en wat er moet veranderen'`
   - Voor specifieke opmerkingen op regels: `gh api repos/{owner}/{repo}/pulls/<nummer>/comments -f body='opmerking' -f commit_id='<sha>' -f path='<file>' -F line=<regel> -f side=RIGHT`
8. Stuur review resultaat naar team lead via SendMessage
9. Bij request-changes: stuur ook details naar implementer zodat die kan fixen
10. Markeer als completed

BELANGRIJK: Post ALTIJD je review als GitHub PR review comment via gh pr review. Dit is hoe een echt team werkt.

Work directory: /Users/diliecat/Documents/claude-code"
})
```

#### Docs-writer
```
Agent({
  name: "docs-writer",
  subagent_type: "general-purpose",
  model: "sonnet",
  team_name: "<team-naam>",
  prompt: "Je bent de docs-writer voor team <naam>. Je hebt twee mogelijke taken:

**Taak 1: README & CLAUDE.md updaten (Task #4)**
Workflow: check TaskList, wacht tot de implementatie-taak completed is, claim je taak. Dan:
1. Lees de huidige README.md en CLAUDE.md
2. Lees de gewijzigde bestanden om te begrijpen wat er veranderd is
3. Update README.md — feature beschrijvingen, configuratie, quick start, etc.
4. Update CLAUDE.md — project structuur, architectuur, conventions (alleen als er structurele changes zijn)
5. Markeer als completed, stuur samenvatting naar team lead via SendMessage

**Taak 2: Wiki updaten (Task #8, optioneel)**
Workflow: check TaskList, wacht tot de PR gemerged is (Task #7 completed). Dan:
1. Clone de wiki: git clone https://github.com/DilieCat/claudebridge.wiki.git in /tmp/
2. Lees bestaande wiki pagina's om te zien welke relevant zijn
3. Update of maak relevante wiki pagina's aan
4. Commit en push naar de wiki repo
5. Markeer als completed, stuur samenvatting naar team lead via SendMessage

BELANGRIJK: Schrijf docs in het Engels (project is internationaal). Houd het beknopt en actueel.

Work directory: /Users/diliecat/Documents/claude-code"
})
```

#### Deployer
```
Agent({
  name: "deployer",
  subagent_type: "general-purpose",
  model: "sonnet",
  team_name: "<team-naam>",
  prompt: "Je bent de deployer voor team <naam>. Je hebt TWEE taken:

**Taak 1: PR aanmaken (Task #5)**
Workflow: check TaskList, wacht tot test EN docs-update completed zijn, claim je taak. Dan:
1. git checkout -b <branch-naam>
2. Stage relevante bestanden (inclusief README.md/CLAUDE.md als die gewijzigd zijn)
3. Commit (Engels, beschrijvend)
4. git push -u origin <branch>
5. gh pr create met Summary + Test plan
6. Stuur de PR URL en het PR-nummer naar de team lead via SendMessage
7. Markeer Task #5 als completed — NIET mergen, wacht op review

**Taak 2: PR mergen (Task #7)**
Workflow: check TaskList, wacht tot de review-taak (Task #6) completed is, claim je taak. Dan:
1. gh pr merge <nummer> --merge
2. git checkout main && git pull
3. Stuur bevestiging naar team lead via SendMessage
4. Markeer Task #7 als completed

BELANGRIJK: NOOIT mergen zonder dat de review completed is. NOOIT direct naar main pushen.

Work directory: /Users/diliecat/Documents/claude-code"
})
```

### Stap 4: Monitoring & Coördinatie

- Wacht op berichten van teammates (komen automatisch)
- Wanneer de deployer de PR heeft aangemaakt, stuur het PR-nummer door naar de reviewer
- Bij review met request-changes: coördineer fixes tussen implementer en reviewer, daarna opnieuw door de pipeline
- Deployer merged pas wanneer reviewer APPROVED heeft
- Na merge: activeer docs-writer voor wiki update (Task #8) als de change relevant is voor de wiki

### Stap 5: Cleanup (na PR merge)

1. Stuur shutdown_request naar ALLE teammates
2. Wacht tot alle shutdown_approved berichten binnen zijn
3. TeamDelete om team resources op te ruimen
4. Update `memory/project-status.md` met wat er gedaan is

---

## Valkuilen — NIET doen

- **NOOIT direct naar main pushen** — altijd via branch + PR
- **NOOIT review overslaan** — ook niet bij "simpele" changes
- **NOOIT alles in één agent** — gespecialiseerde agents per rol
- **NOOIT mergen voor review approved is** — reviewer moet EERST gh pr review posten
- **Check altijd `git branch`** voor commit/push

---

## Model selectie

| Model | Gebruik voor |
|-------|-------------|
| **sonnet** | Researcher, deployer, docs-writer (gebalanceerd) |
| **opus** | Implementer, tester, reviewer (grondig, altijd) |
