// The one window event the tasks panel listens for: `z` flips "show done".
// Its own module because both the registry and panels.tsx need the name, and
// the registry must stay importable without React.
export const TASKS_TOGGLE_DONE = 'floe:tasks-toggle-done'
