import { graphql } from "./linear-client.js";

/**
 * Create an activity emitter bound to a specific agent and session.
 * @param {string} agentName - "enrique" or "devora"
 * @param {string} sessionId - Linear AgentSession ID
 */
export function createEmitter(agentName, sessionId) {
  async function emitActivity(content) {
    try {
      await graphql(agentName, `
        mutation($input: AgentActivityCreateInput!) {
          agentActivityCreate(input: $input) {
            success
          }
        }
      `, {
        input: {
          agentSessionId: sessionId,
          content,
        },
      });
    } catch (err) {
      console.error(`[ACTIVITY] Failed to emit ${content.type} for ${agentName}:`, err.message);
    }
  }

  async function updateSession(input) {
    try {
      await graphql(agentName, `
        mutation($id: String!, $input: AgentSessionUpdateInput!) {
          agentSessionUpdate(id: $id, input: $input) {
            success
          }
        }
      `, { id: sessionId, input });
    } catch (err) {
      console.error(`[ACTIVITY] Failed to update session for ${agentName}:`, err.message);
    }
  }

  return {
    /** Emit a thought (internal progress note). */
    thought(body) {
      return emitActivity({ type: "thought", body });
    },

    /** Emit a tool action. */
    action(action, parameter, result) {
      const content = { type: "action", action, parameter };
      if (result !== undefined) content.result = result;
      return emitActivity(content);
    },

    /** Emit a final response (session → complete). */
    response(body) {
      return emitActivity({ type: "response", body });
    },

    /** Emit an error (session → error). */
    error(body) {
      return emitActivity({ type: "error", body });
    },

    /** Emit an elicitation (request user input). */
    elicitation(body) {
      return emitActivity({ type: "elicitation", body });
    },

    /** Update the plan visible to the user. Replaces the entire plan. */
    updatePlan(steps) {
      return updateSession({ plan: steps });
    },

    /** Add an external URL (e.g. PR link). */
    addExternalUrl(label, url) {
      return updateSession({
        addedExternalUrls: [{ label, url }],
      });
    },
  };
}
