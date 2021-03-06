import React from 'react';
import Dropzone from 'react-dropzone';
import {Icon, Tabs, Pane, Alert} from 'watson-react-components';
import recognizeMicrophone from 'watson-speech/speech-to-text/recognize-microphone';
import recognizeFile from 'watson-speech/speech-to-text/recognize-file';
import ModelDropdown from './model-dropdown.jsx';
import {Transcript} from './transcript.jsx';
import {Keywords, getKeywordsSummary} from './keywords.jsx';
import {SpeakersView} from './speaker.jsx';
import {TimingView} from './timing.jsx';
import samples from '../src/data/samples.json';
import cachedModels from '../src/data/models.json';

const ERR_MIC_NARROWBAND = 'Microphone transcription cannot accommodate narrowband voice models, please select a broadband one.';

export default React.createClass({
  displayName: 'Demo',

  getInitialState() {
    return {
      model: 'en-US_BroadbandModel',
      rawMessages: [],
      formattedMessages: [],
      audioSource: null,
      speakerLabels: false,
      keywords: this.getKeywords('en-US_BroadbandModel'),
      // transcript model and keywords are the state that they were when the button was clicked.
      // Changing them during a transcription would cause a mismatch between the setting sent to the service and what is displayed on the demo, and could cause bugs.
      settingsAtStreamStart: {
        model: '',
        keywords: [],
        speakerLabels: false
      },
      error: null
    };
  },

  reset() {
    if (this.state.audioSource) {
      this.stopTranscription();
    }
    this.setState({rawMessages: [], formattedMessages: [], error: null});
  },

  /**
     * The behavior of several of the views depends on the settings when the transcription was started
     * So, this stores those values in a settingsAtStreamStart object.
     */
  captureSettings() {
    this.setState({
      settingsAtStreamStart: {
        model: this.state.model,
        keywords: this.getKeywordsArr(),
        speakerLabels: this.state.speakerLabels
      }
    });
  },

  stopTranscription() {
    this.stream && this.stream.stop();
    this.setState({audioSource: null});
  },

  getRecognizeOptions(extra) {
    var keywords = this.getKeywordsArr();
    return Object.assign({
      token: this.state.token, smart_formatting: true, // formats phone numbers, currency, etc. (server-side)
      format: true, // adds capitals, periods, and a few other things (client-side)
      model: this.state.model,
      objectMode: true,
      interim_results: true,
      continuous: true,
      word_alternatives_threshold: 0.01, // note: in normal usage, you'd probably set this a bit higher
      keywords: keywords,
      keywords_threshold: keywords.length
        ? 0.01
        : undefined, // note: in normal usage, you'd probably set this a bit higher
      timestamps: true, // set timestamps for each word - automatically turned on by speaker_labels
      speaker_labels: this.state.speakerLabels, // includes the speaker_labels in separate objects unless resultsBySpeaker is enabled
      resultsBySpeaker: this.state.speakerLabels, // combines speaker_labels and results together into single objects, making for easier transcript outputting
      speakerlessInterim: this.state.speakerLabels // allow interim results through before the speaker has been determined
    }, extra);
  },

  isNarrowBand(model) {
    model = model || this.state.model;
    return model.indexOf('Narrowband') !== -1;
  },

  handleMicClick() {
    if (this.state.audioSource === 'mic') {
      return this.stopTranscription();
    }
    this.reset();
    this.setState({audioSource: 'mic'});

    // The recognizeMicrophone() method is a helper method provided by the watson-speech package
    // It sets up the microphone, converts and downsamples the audio, and then transcribes it over a WebSocket connection
    // It also provides a number of optional features, some of which are enabled by default:
    //  * enables object mode by default (options.objectMode)
    //  * formats results (Capitals, periods, etc.) (options.format)
    //  * outputs the text to a DOM element - not used in this demo because it doesn't play nice with react (options.outputElement)
    //  * a few other things for backwards compatibility and sane defaults
    // In addition to this, it passes other service-level options along to the RecognizeStream that manages the actual WebSocket connection.
    this.handleStream(recognizeMicrophone(this.getRecognizeOptions()));
  },

  handleStream(stream) {
    // cleanup old stream if appropriate
    if (this.stream) {
      this.stream.stop();
      this.stream.removeAllListeners();
      this.stream.recognizeStream.removeAllListeners();
    }
    this.stream = stream;
    this.captureSettings();

    // grab the formatted messages and also handle errors and such
    stream.on('data', this.handleFormattedMessage).on('end', this.handleTranscriptEnd).on('error', this.handleError);

    // when errors occur, the end event may not propagate through the helper streams.
    // However, the recognizeStream should always fire a end and close events
    stream.recognizeStream.on('end', () => {
      if (this.state.error) {
        this.handleTranscriptEnd();
      }
    });

    // grab raw messages from the debugging events for display on the JSON tab
    stream.recognizeStream
      .on('message', (frame, json) => this.handleRawdMessage({sent: false, frame, json}))
      .on('send-json', json => this.handleRawdMessage({sent: true, json}))
      .once('send-data', () => this.handleRawdMessage({
        sent: true, binary: true, data: true // discard the binary data to avoid waisting memory
      }))
      .on('close', (code, message) => this.handleRawdMessage({close: true, code, message}));

    // ['open','close','finish','end','error', 'pipe'].forEach(e => {
    //     stream.recognizeStream.on(e, console.log.bind(console, 'rs event: ', e));
    //     stream.on(e, console.log.bind(console, 'stream event: ', e));
    // });
  },

  handleRawdMessage(msg) {
    this.setState({rawMessages: this.state.rawMessages.concat(msg)});
  },

  handleFormattedMessage(msg) {
    this.setState({formattedMessages: this.state.formattedMessages.concat(msg)});
  },

  handleTranscriptEnd() {
    // note: this function will be called twice on a clean end,
    // but may only be called once in the event of an error
    this.setState({audioSource: null});
  },

  componentDidMount() {
    this.fetchToken();
    // tokens expire after 60 minutes, so automatcally fetch a new one ever 50 minutes
    // Not sure if this will work properly if a computer goes to sleep for > 50 minutes and then wakes back up
    // react automatically binds the call to this
    this.setState({'tokenInterval' : setInterval(this.fetchToken, 50 * 60 * 1000) });
  },

  componentWillUnmount() {
    clearInterval(this.state.tokenInterval);
  },

  fetchToken() {
    return fetch('/api/token').then(res => {
      if (res.status != 200) {
        throw new Error('Error retrieving auth token');
      }
      return res.text();
    }). // todo: throw here if non-200 status
    then(token => this.setState({token})).catch(this.handleError);
  },

  getKeywords(model) {
    // a few models have more than two sample files, but the demo can only handle two samples at the moment
    // so this just takes the keywords from the first two samples
    const files = samples[model];
    return files && files.length >= 2 && files[0].keywords + ', ' + files[1].keywords || '';
  },


  supportsSpeakerLabels(model) {
    model = model || this.state.model;
    // todo: read the upd-to-date models list instead of the cached one
    return cachedModels.some(m => m.name === model && m.supported_features.speaker_labels);
  },


  // cleans up the keywords string into an array of individual, trimmed, non-empty keywords/phrases
  getKeywordsArr() {
    return this.state.keywords.split(',').map(k => k.trim()).filter(k => k);
  },

  getFinalResults() {
    return this.state.formattedMessages.filter(r => r.results && r.results.length && r.results[0].final);
  },

  getCurrentInterimResult() {
    const r = this.state.formattedMessages[this.state.formattedMessages.length - 1];

    // When resultsBySpeaker is enabled, each msg.results array may contain multiple results. However, all results
    // in a given message will be either final or interim, so just checking the first one still works here.
    if (!r || !r.results || !r.results.length || r.results[0].final) {
      return null;
    }
    return r;
  },

  getFinalAndLatestInterimResult() {
    const final = this.getFinalResults();
    const interim = this.getCurrentInterimResult();
    if (interim) {
      final.push(interim);
    }
    return final;
  },

  handleError(err, extra) {
    console.error(err, extra);
    if (err.name == 'UNRECOGNIZED_FORMAT') {
      err = 'Unable to determine content type from file header; only wav, flac, and ogg/opus are supported. Please choose a different file.';
    } else if (err.name === 'NotSupportedError' && this.state.audioSource === 'mic') {
      err = 'This browser does not support microphone input.';
    } else if (err.message === '(\'UpsamplingNotAllowed\', 8000, 16000)') {
      err = 'Please select a narrowband voice model to transcribe 8KHz audio files.';
    }
    this.setState({ error: err.message || err });
  },

  render() {

    const buttonsEnabled = !!this.state.token;
    const buttonClass = buttonsEnabled
      ? 'base--button'
      : 'base--button base--button_black';

    let micIconFill = '#000000';
    let micButtonClass = buttonClass;
    if (this.state.audioSource === 'mic') {
      micButtonClass += ' mic-active';
      micIconFill = '#FFFFFF';
    } else if (!recognizeMicrophone.isSupported) {
      micButtonClass += ' base--button_black';
    }

    const err = this.state.error
      ? (
        <Alert type="error" color="red">
          <p className="base--p">{this.state.error}</p>
        </Alert>
      )
      : null;

    const messages = this.getFinalAndLatestInterimResult();
    const micBullet = (typeof window !== "undefined" && recognizeMicrophone.isSupported) ?
        <li className="base--li">Use your microphone to record audio.</li> :
        <li className="base--li base--p_light">Use your microphone to record audio. (Not supported in current browser)</li>;

    return (
      <div>

        <div className="flex buttons">

          <button className={micButtonClass} onClick={this.handleMicClick}>
            <Icon type={this.state.audioSource === 'mic' ? 'stop' : 'microphone'} fill={micIconFill} /> Record Audio
          </button>

        </div>


        <Tabs selected={0}>
          <Pane label="Text">
            {this.state.settingsAtStreamStart.speakerLabels
              ? <SpeakersView messages={messages}/>
              : <Transcript messages={messages}/>}
          </Pane>
        </Tabs>

      </div>
    );
  }
});
