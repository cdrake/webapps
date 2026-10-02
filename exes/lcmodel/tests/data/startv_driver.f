      PROGRAM DRV
      INCLUDE 'lcmodel.inc'
      INTEGER ICASE, JY, J, K
      INTEGER*8 IB
      PI = 3.1415927
      LPRINT = 0
      DO 5 J = 1, 10
         LDUMP(J) = .FALSE.
    5 CONTINUE
      DO 100 ICASE = 1, 3
         NY = 480
         PPMINC = 0.0078125
         PPMCEN = 4.65
         DO 10 JY = 1, NY
            DELPPM(JY) = -0.65 - FLOAT(JY - 1) * PPMINC
   10    CONTINUE
         PPMST = 4.0
         PPMEND = DELPPM(NY) + PPMCEN
         NBACKG = 40
         NBCKMN = 6
         RMSAMP = 123.4
         NMETAB = 5
         PPMPOS(1) = 3.5
         PPMPOS(2) = 1.0
         DO 20 J = 1, MGAP
            PPMSEP(J) = 0.
   20    CONTINUE
         IF (ICASE .EQ. 1) THEN
            NGAP = 0
         ELSE
            NGAP = 3
            PPMGAP(1,1) = 3.0
            PPMGAP(2,1) = 2.8
            PPMGAP(1,2) = 2.75
            PPMGAP(2,2) = 2.6
            PPMGAP(1,3) = 1.2
            PPMGAP(2,3) = 1.15
            IF (ICASE .EQ. 2) THEN
               PPMSEP(1) = 2.9
               PPMSEP(2) = 2.7
            ELSE
               PPMSEP(1) = 2.7
               PPMSEP(2) = 2.9
               PPMSEP(3) = 1.17
            END IF
         END IF
         CALL GBACKG ()
         WRITE (*, '(A, I5)') 'NBACKG', NBACKG
         DO 30 K = 1, MBACKG
            DO 40 JY = 1, NY
               IF (BACKGR(JY,K) .NE. 0.) WRITE (*, '(A,2I5,I12)')
     1            'B', JY, K, TRANSFER(BACKGR(JY,K), 0)
   40       CONTINUE
            DO 50 J = 1, MBACKG
               IF (REGB(J,K) .NE. 0.) WRITE (*, '(A,2I5,I12)')
     1            'R', J, K, TRANSFER(REGB(J,K), 0)
   50       CONTINUE
   30    CONTINUE
         DO 60 J = NMETAB + 1, NMETAB + NBACKG
            WRITE (*, '(A,I5,L2)') 'N', J, NONNEG(J)
   60    CONTINUE
  100 CONTINUE
C     setup3
      MPOWER = 2
      POWER(1) = 1.0D0
      POWER(2) = 1.7D0
      FWHMST = 0.05
      HZPPPM = 123.2
      TOFWHM = 0.8
      DELTAT = 2.5E-4
      NDATA = 64
      FMAIN_POWER = 0.6
      FOTHER_POWER = 0.1
      RPOWMQ = 2.
      NMETAB = 3
      NPOWER(1) = 2
      NPOWER(2) = 1
      NPOWER(3) = 2
      DO 210 K = 1, 3
         DO 220 J = 1, 3
            FRACT_POWER_SD(J,K) = 0.5 / FLOAT(J)
  220    CONTINUE
  210 CONTINUE
      LRT2ST = 10
      CALL SETUP3 ()
      WRITE (*, '(A, I5)') 'NNONL', NNONL
      DO 230 J = 0, NMETAB
         WRITE (*, '(A, 2I5)') 'LPOWEN', J, LPOWEN(J)
  230 CONTINUE
      DO 240 J = 1, NNONL
         WRITE (*, '(A,I5,I21)') 'P', J, TRANSFER(PARNLN(J), IB)
         WRITE (*, '(A,I5,I21)') 'D', J, TRANSFER(DPARMQ(J), IB)
  240 CONTINUE
      DO 250 K = 1, NMETAB
         DO 260 J = 1, 3
            WRITE (*, '(A,2I5,I21)') 'C', J, K,
     1         TRANSFER(COEFF_POWER_SD(J,K), IB)
  260    CONTINUE
  250 CONTINUE
      DO 270 K = 1, NDATA
         DO 280 J = 1, MPOWER
            WRITE (*, '(A,2I5,I21)') 'T', J, K,
     1         TRANSFER(TPOWER(J,K), IB)
  280    CONTINUE
  270 CONTINUE
      END
      SUBROUTINE ERRMES (N, L, CH)
      CHARACTER*(*) CH
      WRITE (*, '(A, 2I4, 1X, A)') 'ERRMES', N, L, CH
      IF (IABS(L) .GE. 4) STOP
      END
