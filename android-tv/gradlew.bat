@rem Minimal Gradle wrapper launcher, written by hand.
@rem The wrapper jar is NOT kept in the repo (CI uses a pinned Gradle instead).
@rem To get it locally, with Gradle 8.11.1 installed, run once:  gradle wrapper --gradle-version 8.11.1
@echo off
setlocal
set APP_HOME=%~dp0
set WRAPPER_JAR=%APP_HOME%gradle\wrapper\gradle-wrapper.jar
if not exist "%WRAPPER_JAR%" (
  echo gradle-wrapper.jar is missing. Run: gradle wrapper --gradle-version 8.11.1 1>&2
  exit /b 1
)
set JAVACMD=java
if defined JAVA_HOME set JAVACMD=%JAVA_HOME%\bin\java
"%JAVACMD%" -Xmx64m -Xms64m %JAVA_OPTS% %GRADLE_OPTS% "-Dorg.gradle.appname=gradlew" -classpath "%WRAPPER_JAR%" org.gradle.wrapper.GradleWrapperMain %*
exit /b %ERRORLEVEL%
