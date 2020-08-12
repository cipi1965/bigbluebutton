import { Tracker } from 'meteor/tracker';
import { Session } from 'meteor/session';
import Settings from '/imports/ui/services/settings';
import Auth from '/imports/ui/services/auth';
import Meetings from '/imports/api/meetings';
import Users from '/imports/api/users';
import VideoStreams from '/imports/api/video-streams';
import UserListService from '/imports/ui/components/user-list/service';
import { makeCall } from '/imports/ui/services/api';
import { notify } from '/imports/ui/services/notification';
import { monitorVideoConnection } from '/imports/utils/stats';
import browser from 'browser-detect';
import getFromUserSettings from '/imports/ui/services/users-settings';
import logger from '/imports/startup/client/logger';

const CAMERA_PROFILES = Meteor.settings.public.kurento.cameraProfiles;
const MULTIPLE_CAMERAS = Meteor.settings.public.app.enableMultipleCameras;
const SKIP_VIDEO_PREVIEW = Meteor.settings.public.kurento.skipVideoPreview;

const SFU_URL = Meteor.settings.public.kurento.wsUrl;
const ROLE_MODERATOR = Meteor.settings.public.user.role_moderator;
const ROLE_VIEWER = Meteor.settings.public.user.role_viewer;
const ENABLE_NETWORK_MONITORING = Meteor.settings.public.networkMonitoring.enableNetworkMonitoring;
const MIRROR_WEBCAM = Meteor.settings.public.app.mirrorOwnWebcam;
const CAMERA_QUALITY_THRESHOLDS = Meteor.settings.public.kurento.cameraQualityThresholds.thresholds || [];

const TOKEN = '_';

class VideoService {
  constructor() {
    this.defineProperties({
      isConnecting: false,
      isConnected: false,
    });
    this.skipVideoPreview = null;
    this.userParameterProfile = null;
    const BROWSER_RESULTS = browser();
    this.isMobile = BROWSER_RESULTS.mobile || BROWSER_RESULTS.os.includes('Android');
    this.isSafari = BROWSER_RESULTS.name === 'safari';

    this.numberOfDevices = 0;

    this.updateNumberOfDevices = this.updateNumberOfDevices.bind(this);
    // Safari doesn't support ondevicechange
    if (!this.isSafari) {
      navigator.mediaDevices.ondevicechange = event => this.updateNumberOfDevices();
    }
    this.updateNumberOfDevices();
  }

  defineProperties(obj) {
    Object.keys(obj).forEach((key) => {
      const privateKey = `_${key}`;
      this[privateKey] = {
        value: obj[key],
        tracker: new Tracker.Dependency(),
      };

      Object.defineProperty(this, key, {
        set: (value) => {
          this[privateKey].value = value;
          this[privateKey].tracker.changed();
        },
        get: () => {
          this[privateKey].tracker.depend();
          return this[privateKey].value;
        },
      });
    });
  }

  fetchNumberOfDevices(devices) {
    const deviceIds = [];
    devices.forEach((d) => {
      const validDeviceId = d.deviceId !== '' && !deviceIds.includes(d.deviceId);
      if (d.kind === 'videoinput' && validDeviceId) {
        deviceIds.push(d.deviceId);
      }
    });

    return deviceIds.length;
  }

  updateNumberOfDevices(devices = null) {
    if (devices) {
      this.numberOfDevices = this.fetchNumberOfDevices(devices);
    } else {
      navigator.mediaDevices.enumerateDevices().then((devices) => {
        this.numberOfDevices = this.fetchNumberOfDevices(devices);
      });
    }
  }

  joinVideo(deviceId) {
    this.deviceId = deviceId;
    this.isConnecting = true;
  }

  joinedVideo() {
    this.isConnected = true;
  }

  exitVideo() {
    if (this.isConnected) {
      logger.info({
        logCode: 'video_provider_unsharewebcam',
      }, `Sending unshare all ${Auth.userID} webcams notification to meteor`);
      const streams = VideoStreams.find(
        {
          meetingId: Auth.meetingID,
          userId: Auth.userID,
        }, { fields: { stream: 1 } },
      ).fetch();

      streams.forEach(s => this.sendUserUnshareWebcam(s.stream));
      this.exitedVideo();
    }
  }

  exitedVideo() {
    this.isConnecting = false;
    this.deviceId = null;
    this.isConnected = false;
  }

  stopVideo(cameraId) {
    const streams = VideoStreams.find(
      {
        meetingId: Auth.meetingID,
        userId: Auth.userID,
      }, { fields: { stream: 1 } },
    ).fetch().length;
    this.sendUserUnshareWebcam(cameraId);
    if (streams < 2) {
      // If the user had less than 2 streams, set as a full disconnection
      this.exitedVideo();
    }
  }

  getSharedDevices() {
    const devices = VideoStreams.find(
      {
        meetingId: Auth.meetingID,
        userId: Auth.userID,
      }, { fields: { deviceId: 1 } },
    ).fetch().map(vs => vs.deviceId);

    return devices;
  }

  sendUserShareWebcam(cameraId) {
    makeCall('userShareWebcam', cameraId);
  }

  sendUserUnshareWebcam(cameraId) {
    makeCall('userUnshareWebcam', cameraId);
  }

  getAuthenticatedURL() {
    return Auth.authenticateURL(SFU_URL);
  }

  getVideoStreams() {
    let streams = VideoStreams.find(
      { meetingId: Auth.meetingID },
      {
        fields: {
          userId: 1, stream: 1, name: 1,
        },
      },
    ).fetch();

    const moderatorOnly = this.webcamsOnlyForModerator();
    if (moderatorOnly) streams = this.filterModeratorOnly(streams);

    const connectingStream = this.getConnectingStream(streams);
    if (connectingStream) streams.push(connectingStream);

    return streams.map(vs => ({
      cameraId: vs.stream,
      userId: vs.userId,
      name: vs.name,
    })).sort(UserListService.sortUsersByName);
  }

  getConnectingStream(streams) {
    let connectingStream;

    if (this.isConnecting) {
      if (this.deviceId) {
        const stream = this.buildStreamName(Auth.userID, this.deviceId);
        if (!this.hasStream(streams, stream) && !this.isUserLocked()) {
          connectingStream = {
            stream,
            userId: Auth.userID,
            name: Auth.fullname,
          };
        } else {
          // Connecting stream is already stored at database
          this.deviceId = null;
          this.isConnecting = false;
        }
      } else {
        logger.error({
          logCode: 'video_provider_missing_deviceid',
        }, 'Could not retrieve a valid deviceId');
      }
    }

    return connectingStream;
  }

  buildStreamName(userId, deviceId) {
    return `${userId}${TOKEN}${deviceId}`;
  }

  hasVideoStream() {
    const videoStreams = VideoStreams.findOne({ userId: Auth.userID },
      { fields: {} });
    return !!videoStreams;
  }

  hasStream(streams, stream) {
    return streams.find(s => s.stream === stream);
  }

  filterModeratorOnly(streams) {
    const me = Users.findOne({ userId: Auth.userID });
    const amIViewer = me.role === ROLE_VIEWER;

    if (amIViewer) {
      const moderators = Users.find(
        {
          meetingId: Auth.meetingID,
          connectionStatus: 'online',
          role: ROLE_MODERATOR,
        },
        { fields: { userId: 1 } },
      ).fetch().map(user => user.userId);

      return streams.reduce((result, stream) => {
        const { userId } = stream;

        const isModerator = moderators.includes(userId);
        const isMe = me.userId === userId;

        if (isModerator || isMe) result.push(stream);

        return result;
      }, []);
    }
    return streams;
  }

  disableCam() {
    const m = Meetings.findOne({ meetingId: Auth.meetingID },
      { fields: { 'lockSettingsProps.disableCam': 1 } });
    return m.lockSettingsProps ? m.lockSettingsProps.disableCam : false;
  }

  webcamsOnlyForModerator() {
    const m = Meetings.findOne({ meetingId: Auth.meetingID },
      { fields: { 'usersProp.webcamsOnlyForModerator': 1 } });
    return m.usersProp ? m.usersProp.webcamsOnlyForModerator : false;
  }

  getInfo() {
    const m = Meetings.findOne({ meetingId: Auth.meetingID },
      { fields: { 'voiceProp.voiceConf': 1 } });
    const voiceBridge = m.voiceProp ? m.voiceProp.voiceConf : null;
    return {
      userId: Auth.userID,
      userName: Auth.fullname,
      meetingId: Auth.meetingID,
      sessionToken: Auth.sessionToken,
      voiceBridge,
    };
  }

  mirrorOwnWebcam(user) {
    // only true if setting defined and video ids match
    const isOwnWebcam = user ? this.userId() === user.userId : true;
    const isEnabledMirroring = getFromUserSettings('bbb_mirror_own_webcam', MIRROR_WEBCAM);
    return isOwnWebcam && isEnabledMirroring;
  }

  getMyStream(deviceId) {
    const videoStream = VideoStreams.findOne(
      {
        meetingId: Auth.meetingID,
        userId: Auth.userID,
        deviceId,
      }, { fields: { stream: 1 } },
    );
    return videoStream ? videoStream.stream : null;
  }

  isUserLocked() {
    return !!Users.findOne({
      userId: Auth.userID,
      locked: true,
      role: { $ne: ROLE_MODERATOR },
    }, { fields: {} }) && this.disableCam();
  }

  lockUser() {
    if (this.isConnected) {
      this.exitVideo();
    }
  }

  isLocalStream(cameraId) {
    return cameraId.startsWith(Auth.userID);
  }

  playStart(cameraId) {
    if (this.isLocalStream(cameraId)) {
      this.sendUserShareWebcam(cameraId);
      this.joinedVideo();
    }
  }

  getCameraProfile() {
    const profileId = Session.get('WebcamProfileId') || '';
    const cameraProfile = CAMERA_PROFILES.find(profile => profile.id === profileId)
      || CAMERA_PROFILES.find(profile => profile.default)
      || CAMERA_PROFILES[0];
    const deviceId = Session.get('WebcamDeviceId');
    if (deviceId) {
      cameraProfile.constraints = cameraProfile.constraints || {};
      cameraProfile.constraints.deviceId = { exact: deviceId };
    }

    return cameraProfile;
  }

  addCandidateToPeer(peer, candidate, cameraId) {
    peer.addIceCandidate(candidate, (error) => {
      if (error) {
        // Just log the error. We can't be sure if a candidate failure on add is
        // fatal or not, so that's why we have a timeout set up for negotiations
        // and listeners for ICE state transitioning to failures, so we won't
        // act on it here
        logger.error({
          logCode: 'video_provider_addicecandidate_error',
          extraInfo: {
            cameraId,
            error,
          },
        }, `Adding ICE candidate failed for ${cameraId} due to ${error.message}`);
      }
    });
  }

  processInboundIceQueue(peer, cameraId) {
    while (peer.inboundIceQueue.length) {
      const candidate = peer.inboundIceQueue.shift();
      this.addCandidateToPeer(peer, candidate, cameraId);
    }
  }

  onBeforeUnload() {
    this.exitVideo();
  }

  isDisabled() {
    const { viewParticipantsWebcams } = Settings.dataSaving;

    return this.isUserLocked() || this.isConnecting || !viewParticipantsWebcams;
  }

  getRole(isLocal) {
    return isLocal ? 'share' : 'viewer';
  }

  getSkipVideoPreview(fromInterface = false) {
    if (this.skipVideoPreview === null) {
      this.skipVideoPreview = getFromUserSettings('bbb_skip_video_preview', false) || SKIP_VIDEO_PREVIEW;
    }

    return this.skipVideoPreview && !fromInterface;
  }

  getUserParameterProfile() {
    if (this.userParameterProfile === null) {
      this.userParameterProfile = getFromUserSettings(
        'bbb_preferred_camera_profile',
        (CAMERA_PROFILES.filter(i => i.default) || {}).id,
      );
    }

    return this.userParameterProfile;
  }

  isMultipleCamerasEnabled() {
    // Multiple cameras shouldn't be enabled with video preview skipping
    // Mobile shouldn't be able to share more than one camera at the same time
    // Safari needs to implement devicechange event for safe device control
    return MULTIPLE_CAMERAS
      && !this.getSkipVideoPreview()
      && !this.isMobile
      && !this.isSafari
      && this.numberOfDevices > 1;
  }

  monitor(conn) {
    if (ENABLE_NETWORK_MONITORING) monitorVideoConnection(conn);
  }

  amIModerator() {
    return Users.findOne({ userId: Auth.userID },
      { fields: { role: 1 } }).role === ROLE_MODERATOR;
  }

  getNumberOfPublishers() {
    return VideoStreams.find({ meetingId: Auth.meetingID }).count();
  }

  isProfileBetter(newProfileId, originalProfileId) {
    return CAMERA_PROFILES.findIndex(({ id }) => id === newProfileId)
      > CAMERA_PROFILES.findIndex(({ id }) => id === originalProfileId);
  }

  applyBitrate(peer, bitrate) {
    const peerConnection = peer.peerConnection;
    if ('RTCRtpSender' in window
      && 'setParameters' in window.RTCRtpSender.prototype
      && 'getParameters' in window.RTCRtpSender.prototype) {
      peerConnection.getSenders().forEach((sender) => {
        const { track } = sender;
        if (track && track.kind === 'video') {
          const parameters = sender.getParameters();
          if (!parameters.encodings) {
            parameters.encodings = [{}];
          }

          const normalizedBitrate = bitrate * 1000;
          // Only reset bitrate if it changed in some way to avoid enconder fluctuations
          if (parameters.encodings[0].maxBitrate !== normalizedBitrate) {
            parameters.encodings[0].maxBitrate = normalizedBitrate;
            sender.setParameters(parameters)
              .then(() => {
                logger.info({
                  logCode: 'video_provider_bitratechange',
                  extraInfo: { bitrate },
                }, `Bitrate changed: ${bitrate}`);
              })
              .catch((error) => {
                logger.warn({
                  logCode: 'video_provider_bitratechange_failed',
                  extraInfo: { bitrate, errorMessage: error.message, errorCode: error.code },
                }, 'Bitrate change failed.');
              });
          }
        }
      });
    }
  }

  // Some browsers (mainly iOS Safari) garble the stream if a constraint is
  // reconfigured without propagating previous height/width info
  reapplyResolutionIfNeeded(track, constraints) {
    if (typeof track.getSettings !== 'function') {
      return constraints;
    }

    const trackSettings = track.getSettings();

    if (trackSettings.width && trackSettings.height) {
      return {
        ...constraints,
        width: trackSettings.width,
        height: trackSettings.height,
      };
    }
    return constraints;
  }

  applyCameraProfile(peer, profileId) {
    const profile = CAMERA_PROFILES.find(targetProfile => targetProfile.id === profileId);

    if (!profile) {
      logger.warn({
        logCode: 'video_provider_noprofile',
        extraInfo: { profileId },
      }, 'Apply failed: no camera profile found.');
      return;
    }

    // Profile is currently applied or it's better than the original user's profile,
    // skip
    if (peer.currentProfileId === profileId
      || this.isProfileBetter(profileId, peer.originalProfileId)) {
      return;
    }

    const { bitrate, constraints } = profile;

    if (bitrate) {
      this.applyBitrate(peer, bitrate);
    }

    if (constraints && typeof constraints === 'object') {
      peer.peerConnection.getSenders().forEach((sender) => {
        const { track } = sender;
        if (track && track.kind === 'video' && typeof track.applyConstraints === 'function') {
          const normalizedVideoConstraints = this.reapplyResolutionIfNeeded(track, constraints);
          track.applyConstraints(normalizedVideoConstraints)
            .then(() => {
              logger.info({
                logCode: 'video_provider_profile_applied',
                extraInfo: { profileId },
              }, `New camera profile applied: ${profileId}`);
              peer.currentProfileId = profileId;
            })
            .catch((error) => {
              logger.warn({
                logCode: 'video_provider_profile_apply_failed',
                extraInfo: { errorName: error.name, errorCode: error.code },
              }, 'Error applying camera profile');
            });
        }
      });
    }
  }

  getThreshold(numberOfPublishers) {
    let targetThreshold = { threshold: 0, profile: 'original' };
    let finalThreshold = { threshold: 0, profile: 'original' };

    for (let mapIndex = 0; mapIndex < CAMERA_QUALITY_THRESHOLDS.length; mapIndex++) {
      targetThreshold = CAMERA_QUALITY_THRESHOLDS[mapIndex];
      if (targetThreshold.threshold <= numberOfPublishers) {
        finalThreshold = targetThreshold;
      }
    }

    return finalThreshold;
  }
}

const videoService = new VideoService();

export default {
  exitVideo: () => videoService.exitVideo(),
  joinVideo: deviceId => videoService.joinVideo(deviceId),
  stopVideo: cameraId => videoService.stopVideo(cameraId),
  getVideoStreams: () => videoService.getVideoStreams(),
  getInfo: () => videoService.getInfo(),
  getMyStream: deviceId => videoService.getMyStream(deviceId),
  isUserLocked: () => videoService.isUserLocked(),
  lockUser: () => videoService.lockUser(),
  getAuthenticatedURL: () => videoService.getAuthenticatedURL(),
  isLocalStream: cameraId => videoService.isLocalStream(cameraId),
  hasVideoStream: () => videoService.hasVideoStream(),
  isDisabled: () => videoService.isDisabled(),
  playStart: cameraId => videoService.playStart(cameraId),
  getCameraProfile: () => videoService.getCameraProfile(),
  addCandidateToPeer: (peer, candidate, cameraId) => videoService.addCandidateToPeer(peer, candidate, cameraId),
  processInboundIceQueue: (peer, cameraId) => videoService.processInboundIceQueue(peer, cameraId),
  getRole: isLocal => videoService.getRole(isLocal),
  getSharedDevices: () => videoService.getSharedDevices(),
  getSkipVideoPreview: fromInterface => videoService.getSkipVideoPreview(fromInterface),
  getUserParameterProfile: () => videoService.getUserParameterProfile(),
  isMultipleCamerasEnabled: () => videoService.isMultipleCamerasEnabled(),
  monitor: conn => videoService.monitor(conn),
  mirrorOwnWebcam: user => videoService.mirrorOwnWebcam(user),
  onBeforeUnload: () => videoService.onBeforeUnload(),
  notify: message => notify(message, 'error', 'video'),
  updateNumberOfDevices: devices => videoService.updateNumberOfDevices(devices),
  applyCameraProfile: (peer, newProfile) => videoService.applyCameraProfile(peer, newProfile),
  getThreshold: numberOfPublishers => videoService.getThreshold(numberOfPublishers),
};
