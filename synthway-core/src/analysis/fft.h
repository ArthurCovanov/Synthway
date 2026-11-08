#ifndef SW_ANALYSIS_FFT_H
#define SW_ANALYSIS_FFT_H

#include <stdbool.h>
#include <stdint.h>

/* In-place complex FFT (iterative radix 2). n must be a power of two.
   inverse: the backward transform, without the 1/n scaling. */
void sw_fft(float* re, float* im, uint32_t n, bool inverse);

#endif /* SW_ANALYSIS_FFT_H */
