#ifndef SW_ANALYSIS_PITCH_H
#define SW_ANALYSIS_PITCH_H

#include <stdint.h>

/* Highest fundamental searched: above the top note of a piano (C8, 4186 Hz) */
#define SW_PITCH_MAX_HZ 5000.0f

/* Fundamental frequency of x (n samples, mono) by the McLeod pitch method
   (McLeod & Wyvill, "A smarter way to find pitch", 2005): the period is the
   first lag at which the signal best matches itself. The window must hold two
   periods, so the lowest note found is sample_rate / (n / 2).
   Returns 0 when no period stands out (silence, noise). out_clarity gets how
   well the signal matches itself one period later, in [0, 1].
   n need not be a power of two. re and im are scratch buffers of 2 * n floats
   rounded up to a power of two, nsdf of n / 2 + 1 floats. */
float sw_pitch_detect(
    const float* x,
    uint32_t n,
    float sample_rate,
    float* re,
    float* im,
    float* nsdf,
    float* out_clarity
);

/* Clarity of another period (in samples), from the nsdf that sw_pitch_detect
   filled for the same n: the height of its nearest peak, in [0, 1] */
float sw_pitch_clarity_at(const float* nsdf, uint32_t n, float period);

#endif /* SW_ANALYSIS_PITCH_H */
