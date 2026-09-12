# Guida operativa Triad+

Triad+ è un metodo operativo per un coding-agent host. Non avvia daemon,
scheduler, database di workflow o una macchina a stati autonoma.

## Il metodo

```text
ready → in_progress → verifying → in_review → approved
                                      ├── rework → in_progress
                                      └── blocked
```

L’Orchestrator decide il prossimo passo e le escalation. Il Developer esegue un
tentativo delimitato. Il Reviewer decide `approved`, `rework` oppure `blocked`.

Prima del lavoro l’Orchestrator congela il PRD, dichiara card misurabili,
repository/worktree/branch e quality gate deterministici. Mostra il piano al
proprietario, poi delega normalmente sviluppo e review.

Dopo il completamento del Developer avviene la verifica: tramite hook validato
quando disponibile, altrimenti con dispatch esplicito dell’Orchestrator. Il
verifier esegue solo comandi `control-plane` dichiarati. L’evidence atomica lega
assignment ID/hash, run, branch del worktree, fingerprint del candidato, hash di
PRD/card e definizione dei gate. “I test passano” detto dall’agente è una claim;
l’output del verifier è evidence derivata dall’ambiente. Evidence fallita o
invalida non può essere trattata come pass.

Per Codex la modalità `auto` usa intenzionalmente il dispatch esplicito. Il
percorso asincrono `SubagentStop` resta disponibile solo come opt-in
sperimentale: gli hook producono evidence, mentre l’Orchestrator mantiene
l’autorità sull’avanzamento del loop.

L’adapter GitHub Copilot usa custom agent di progetto e la skill `triad`, con
dispatch esplicito della verification e senza hook di lifecycle. Lo smoke della
desktop app ha validato contesti distinti per i ruoli e la continuazione
unattended, oltre ai controlli CLI di asset e doctor.

Il Reviewer riceve card, diff, report Developer, rilievi precedenti ed evidence.
`rework` torna al Developer con una correzione delimitata; `blocked` richiede
all’Orchestrator di escalare la decisione. Le push normali possono essere autonome
dopo i goal dichiarati. La consegna formale al proprietario è un gate distinto:
registra push finale, eventuale valutazione, handoff, stato finale della run e
prova pratica prima di dichiarare il progetto consegnato. Avvio e stop della demo
restano del proprietario.

Una card può aggiungere una lista `required_gates` di gate ID del repository.
La lista è additiva: i gate globalmente obbligatori continuano a essere eseguiti,
quelli opzionali selezionati diventano obbligatori per la card e gli opzionali non
selezionati possono essere saltati. Lista assente o vuota mantiene il
comportamento legacy. Triad collega e registra gli ID senza attribuire loro un
significato visuale o di altro dominio.

## Target di qualità immutabile

Un progetto può optare per `project.quality_contract`, che collega al run un
fingerprint canonico del Quality Baseline JSON e verifica le source hashate prima
del dispatch e dei gate costosi. Drift o manifest invalido fermano il run come
contesto invalido senza consumare il budget di retry del prodotto. I criteri
`product_quality` vengono inviati al nuovo Evaluator+; quelli
`delivery_closure` sono verificati separatamente prima di `delivered`. Senza
questo opt-in i progetti legacy restano invariati.

## Retry e scope del candidato

Gli attempt sono record storici di esecuzione. I nuovi workspace separano e
limitano le transizioni di recovery runtime e di remediation del candidato: un
rework o uno scope cleanup non consuma il budget di recovery. Una card può
attivare un contratto deterministico sui path; il verifier confronta il delta
completo con il baseline originario della card prima dei gate costosi. Uno scope
PASS non sostituisce mai la review indipendente.

## Evaluator+

Evaluator+ è opzionale e fuori dal loop produttivo. Se abilitato in `team.json`,
l’Orchestrator lo avvia automaticamente dopo `approved`; osserva solo
goal, target di accettazione, candidato finale ed evidence del verifier. Produce
`PASS`, `FAIL` oppure `INDETERMINATE`. Un `FAIL` non modifica la run chiusa e non
avvia rework. Vedi [Evaluator+](evaluator-plus.md).

## Decisioni umane e record

Triad+ interpella il proprietario solo per criteri di successo mancanti, cambi di
scope/policy materiali, ambiguità non risolvibili, fallimenti ripetuti o demo
richieste. Conserva PRD immutabile, card, assignment, evidence, report di review,
eventuali report Evaluator+ e handoff in un workspace di controllo separato. Non
inserire token o segreti. Gli hook sono un’ottimizzazione, non autorità: il
dispatch esplicito della verification resta sempre disponibile. Vedi la
[matrice di compatibilità](compatibility.md).

Per ogni demo configurata, registra nel progetto e nell’handoff comando, URL
locale, modalità di accesso remoto e URL remoto. `localhost` è solo locale: non
va indicato a chi prova da remoto. Avvia il servizio soltanto su richiesta del
proprietario e verifica l’URL remoto dichiarato prima di comunicarlo.
