#include "interpreter/interpreter.h"

uint32_t sw_interpreter_active_notes(
    const sw_interpreter_note* notes,
    uint32_t note_count,
    uint32_t step,
    uint32_t* active_ids,
    uint32_t active_capacity
) {
    uint32_t active_count = 0;
    if (!notes || !active_ids || active_capacity == 0) return 0;
    for (uint32_t i = 0; i < note_count && active_count < active_capacity; ++i) {
        const sw_interpreter_note* note = &notes[i];
        if (note->length_steps > 0 && step >= note->start_step &&
            step - note->start_step < note->length_steps) {
            active_ids[active_count++] = note->note_id;
        }
    }
    return active_count;
}
