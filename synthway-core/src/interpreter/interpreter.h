#ifndef SW_INTERPRETER_INTERPRETER_H
#define SW_INTERPRETER_INTERPRETER_H

#include <stdint.h>

typedef struct sw_interpreter_note {
    uint32_t start_step;
    uint32_t length_steps;
    uint32_t note_id;
} sw_interpreter_note;

/* Collect notes sounding at a sixteenth-note position, in composition order. */
uint32_t sw_interpreter_active_notes(
    const sw_interpreter_note* notes,
    uint32_t note_count,
    uint32_t step,
    uint32_t* active_ids,
    uint32_t active_capacity
);

#endif
