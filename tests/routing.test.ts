import { describe, expect, it } from 'vitest';
import { ROUTE_RULES, routeDecisionSchema } from '../server/contracts.js';
import { approvedRoutingExamples } from './routing-fixtures.js';



describe('request routing contract',()=>{
  it('provides 12 concrete request and context examples with route-compatible rule IDs',()=>{
    expect(approvedRoutingExamples.length).toBeGreaterThanOrEqual(20);
    for(const example of approvedRoutingExamples){
      const parsed=routeDecisionSchema.parse({route:example.route,rule_id:example.rule_id,justification:example.justification});
      expect(parsed.route).toBe(example.route);
      expect(ROUTE_RULES[example.rule_id]).toBe(example.route);
    }
  });
  it('rejects mismatched route/rule pairs, extra fields, and empty justifications',()=>{
    const direct=approvedRoutingExamples[0];
    expect(routeDecisionSchema.safeParse({route:'hard_task',rule_id:direct.rule_id,justification:direct.justification}).success).toBe(false);
    expect(routeDecisionSchema.safeParse({route:direct.route,rule_id:direct.rule_id,justification:direct.justification,debug:'extra'}).success).toBe(false);
    expect(routeDecisionSchema.safeParse({route:'simple_implementation',rule_id:'simple_mechanical_dependency_upgrade',justification:' '}).success).toBe(false);
    expect(routeDecisionSchema.safeParse({route:'hard_task',rule_id:'hard_major_dependency_upgrade',justification:'A major upgrade needs compatibility investigation.'}).success).toBe(true);
  });
  it('accepts a captured compatible patch-upgrade classification with concise nonempty evidence',()=>{
    expect(routeDecisionSchema.parse({route:'simple_implementation',rule_id:'simple_mechanical_dependency_upgrade',justification:'Known-compatible bounded patch release with no API changes; update the lockfile and run the specified test.'})).toMatchObject({route:'simple_implementation',rule_id:'simple_mechanical_dependency_upgrade'});
  });
});
