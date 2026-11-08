#ifndef SW_ANALYSIS_NOTES_H
#define SW_ANALYSIS_NOTES_H

#include "synthway/types.h"

/* A note found among the partials of one moment */
typedef struct sw_note {
    float frequency_hz;
    float salience;            /* how much of the partials it explains, weighed (see sw_notes_find) */
} sw_note;

/* The notes of one analysis (its partials), strongest first, at most capacity:
   several notes played together. The note whose harmonics (within 30 cents,
   up to the 16th) explain the most is taken first: each harmonic counts by
   its amplitude, divided by the square root of its rank, but no more than the
   mean of it and its neighbours (a lone strong harmonic is no proof of a
   note), and the whole is weighed by how strong the note's own fundamental is
   next to its strongest harmonic (a missing fundamental under two notes played
   together would explain them both). Its harmonics are then taken out of the
   partials, as far as it explains them, and the next note is looked for in
   what is left, while it reaches at least a fifth of the first.
   Notes from min_hz to max_hz. Returns the number of notes found. */
uint32_t sw_notes_find(
    const synthway_analysis_t* analysis,
    float min_hz,
    float max_hz,
    sw_note* out,
    uint32_t capacity
);

#endif /* SW_ANALYSIS_NOTES_H */
