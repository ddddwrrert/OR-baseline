Improve the solution by orchestrating and improving the search. Fitness comes from the official task evaluator. The total search budget is 100 new candidates. Run evolve_run in small chunks using the same max_budget each time, then use evolve_status to inspect the latest results.

For AHC, let the built-in baseline search complete its matched diagnostic forks. Use its five observations, state probabilities, route history, and budget accounting to decide which search mechanism to change. Check route growth, delayed descendant credit, matched local controls, and the reason for dormancy before redirecting resources. Preserve the verified best candidate and use the historical findings when returning to an earlier strategic decision. Change the search policy through the baseline_policy provider between chunks when the evidence supports a change. Keep the existing official evaluator and pinned candidate budget.

Your role is to orchestrate, diagnose, and revise the search. Use the worker pool for solution changes. Do not use the web or search for existing solutions. Do not give workers access to external solution search.

