#ifndef SW_SYNTH_REVERB_H
#define SW_SYNTH_REVERB_H

/* Stereo reverb of a mono input: the Schroeder-Moorer structure with the
   tuning of Freeverb (Jezar at Dreampoint, 2000, public domain). Each channel
   sums eight low-passed feedback combs, then goes through four allpasses in
   series; the right channel's delays are a little longer, so the two channels
   differ. Delays are scaled to the sample rate, in buffers of fixed size:
   nothing is allocated. */

#include <stdbool.h>
#include <stdint.h>

#define SW_REVERB_COMBS 8
#define SW_REVERB_ALLPASSES 4
/* Delays are sized for sample rates up to this one; above it, they keep the
   lengths of this rate (a smaller room) */
#define SW_REVERB_MAX_RATE 192000
/* Longest delays (Freeverb's, at 44.1 kHz, with the right channel's spread) at SW_REVERB_MAX_RATE */
#define SW_REVERB_COMB_CAPACITY ((1617 + 23) * SW_REVERB_MAX_RATE / 44100 + 1)
#define SW_REVERB_ALLPASS_CAPACITY ((556 + 23) * SW_REVERB_MAX_RATE / 44100 + 1)

typedef struct sw_reverb_comb {
    float buffer[SW_REVERB_COMB_CAPACITY];
    uint32_t length;
    uint32_t index;
    float store;                     /* state of its low-pass */
} sw_reverb_comb;

typedef struct sw_reverb_allpass {
    float buffer[SW_REVERB_ALLPASS_CAPACITY];
    uint32_t length;
    uint32_t index;
} sw_reverb_allpass;

typedef struct sw_reverb_channel {
    sw_reverb_comb combs[SW_REVERB_COMBS];
    sw_reverb_allpass allpasses[SW_REVERB_ALLPASSES];
} sw_reverb_channel;

typedef struct sw_reverb {
    sw_reverb_channel channels[2];   /* left, right */
    uint32_t sample_rate;            /* the delays are sized for */
    float dry;                       /* gains, smoothed towards those of the mix */
    float wet;
    bool active;                     /* false: the input passes through untouched */
} sw_reverb;

/* Reverb off, nothing to clear yet */
void sw_reverb_init(sw_reverb* reverb);

/* Mixes the reverb into frame_count interleaved frames, in place. The room is
   fed the mean of channels 0 and 1 (left and right, which differ only with a
   spread unison), and each channel keeps its own dry sound; with two channels
   or more, even channels get the left reverb, odd channels the right one, and
   a single channel gets their mean. mix in [0, 1] is the
   share of reverb, as an equal-power crossfade. At mix 0 the frames are left
   untouched, once the previous mix has faded out. */
void sw_reverb_process(
    sw_reverb* reverb,
    float mix,
    uint32_t sample_rate,
    uint32_t channels,
    float* frames,
    uint32_t frame_count
);

#endif /* SW_SYNTH_REVERB_H */
